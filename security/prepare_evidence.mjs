import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ROOT, POLICY, argument, readJson, writeJson, isMain, fingerprint } from './matrix_lib.mjs';
import { yamlDocuments, filesIn } from './change_impact.mjs';
import { inspectImage } from './image_evidence.mjs';
import { sourceFingerprints } from './matrix_runtime.mjs';

export function terraformEvidence(events) {
  const failures = events.filter(event => event.type === 'diagnostic' && event.diagnostic?.severity === 'error');
  if (failures.length) throw new Error(failures.map(event => event.diagnostic.summary + ': ' + event.diagnostic.detail).join('\n'));
  const stateEvent = events.find(event => event.type === 'test_state');
  if (!stateEvent) throw new Error('Terraform did not emit test_state; run terraform test -json -verbose');
  const state = stateEvent.test_state?.state ?? stateEvent.test_state;
  const values = state?.values ?? state;
  const root = values?.root_module;
  if (!root) throw new Error('Terraform test state has no root module');
  const resources = [];
  function visit(module) {
    resources.push(...(module.resources ?? []));
    for (const child of module.child_modules ?? []) visit(child);
  }
  visit(root);
  if (!resources.length) throw new Error('Terraform emitted an empty configuration state');
  return {
    evidence_level: 'TERRAFORM_MOCK_STATE', resources,
    outputs: Object.fromEntries(Object.entries(values.outputs ?? {}).map(([key, value]) => [key, value.value]))
  };
}

export function renderedDocuments(root, policy, terraform, record) {
  const contract = terraform.outputs.delivery_contract;
  if (!contract?.repository_url || !contract?.workload_role) throw new Error('Missing Terraform delivery contract');
  const rendered = [];
  for (const file of filesIn(root, 'app/kubernetes').filter(file => /\.ya?ml$/.test(file))) {
    const original = fs.readFileSync(path.join(root, file), 'utf8');
    const text = original.replaceAll('REPLACE_WITH_RELEASE_IMAGE', record.repository + '@' + record.digest)
      .replaceAll('REPLACE_WITH_WORKLOAD_ROLE', contract.workload_role);
    if (text.includes('REPLACE_WITH_')) throw new Error('Unresolved workload placeholder in ' + file);
    rendered.push(...yamlDocuments(text, file));
  }
  return rendered;
}

export async function prepareEvidence({ root = ROOT, terraform = 'terraform', imageFile = null, marker = null, skipTerraform = false, skipImage = false, imageNoCache = false } = {}) {
  const artifactDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const logFile = path.join(artifactDirectory, 'terraform-test.jsonl');
  const provenanceFile = path.join(artifactDirectory, 'terraform-provenance.json');
  const terraformFingerprint = () => fingerprint(Object.fromEntries(Object.entries(sourceFingerprints(root))
    .filter(([file]) => file.startsWith('patterns/fully-private-cluster/'))));
  const before = terraformFingerprint();
  if (skipTerraform && (!fs.existsSync(provenanceFile) || JSON.parse(fs.readFileSync(provenanceFile, 'utf8')).source_fingerprint !== before)) {
    throw new Error('Terraform evidence is stale or has no provenance; rerun the Terraform evaluation');
  }
  if (!skipTerraform) {
    const directory = '-chdir=' + path.join(root, 'patterns/fully-private-cluster');
    for (const command of [
      [directory, 'fmt', '-check', '-recursive'],
      [directory, 'init', '-backend=false', '-input=false', '-lockfile=readonly'],
      [directory, 'validate', '-no-color']
    ]) execFileSync(terraform, command, { stdio: 'inherit', timeout: 600_000 });
    let stdout;
    try {
      stdout = execFileSync(terraform, ['-chdir=' + path.join(root, 'patterns/fully-private-cluster'), 'test', '-json', '-verbose'], {
        encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, timeout: 600_000
      });
    } catch (error) {
      if (error.stdout) fs.writeFileSync(logFile, error.stdout);
      throw new Error('Terraform mock evaluation failed. Inspect artifacts/terraform-test.jsonl');
    }
    fs.writeFileSync(logFile, stdout);
    if (terraformFingerprint() !== before) throw new Error('Terraform source changed during evaluation');
    writeJson(provenanceFile, { source_fingerprint: before, evidence_level: 'TERRAFORM_MOCK_STATE' });
  }
  const events = fs.readFileSync(logFile, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const tf = terraformEvidence(events);
  const policy = readJson(POLICY, root);
  const contextFingerprint = fingerprint(Object.fromEntries(filesIn(root, 'app')
    .filter(file => !file.startsWith('app/kubernetes/')).map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')])));
  let image;
  if (skipImage) {
    image = readJson('artifacts/image-evidence.json', root);
    if (image.context_fingerprint !== contextFingerprint) throw new Error('Image evidence is stale for the build context');
  } else {
    const synthetic = marker ?? 'matrix-build-' + randomBytes(20).toString('hex');
    if (!imageFile) {
      const markerFile = path.join(artifactDirectory, 'build-marker.txt');
      imageFile = path.join(artifactDirectory, 'image.oci.tar');
      fs.writeFileSync(markerFile, synthetic);
      execFileSync('docker', ['buildx', 'build', ...(imageNoCache ? ['--no-cache'] : []), '--platform=linux/amd64', '--provenance=false', '--sbom=false',
        '--secret', 'id=matrix_marker,src=' + markerFile,
        '--output', 'type=oci,dest=' + imageFile, path.join(root, 'app')], {
        stdio: 'inherit', timeout: 600_000
      });
      fs.unlinkSync(markerFile);
    }
    image = await inspectImage(imageFile, synthetic);
    image.context_fingerprint = contextFingerprint;
    writeJson(path.join(artifactDirectory, 'image-evidence.json'), image);
  }
  const record = { repository: tf.outputs.delivery_contract?.repository_url, digest: image.digest, source: image.evidence_level };
  const evidence = {
    schema_version: 1, terraform: tf, image, release: record, policy,
    manifests: renderedDocuments(root, policy, tf, record),
    workflows: Object.fromEntries(filesIn(root, '.github/workflows').filter(file => /\.ya?ml$/.test(file))
      .map(file => [file, yamlDocuments(fs.readFileSync(path.join(root, file), 'utf8'), file)[0]])),
    file_hashes: Object.fromEntries(['app/Dockerfile', 'app/server.mjs', POLICY]
      .map(file => [file, fingerprint(fs.readFileSync(path.join(root, file), 'utf8'))])),
    source_fingerprints: sourceFingerprints(root),
    observations: { aws_runtime: 'PENDING', registry_publication: 'PENDING', kubernetes_runtime: 'PENDING' }
  };
  writeJson(path.join(artifactDirectory, 'evidence.json'), evidence);
  return evidence;
}

if (isMain(import.meta)) {
  try {
    const args = process.argv.slice(2);
    const result = await prepareEvidence({
      terraform: argument(args, '--terraform', 'terraform'),
      imageFile: argument(args, '--image'), marker: argument(args, '--marker'),
      skipTerraform: args.includes('--reuse-terraform'), skipImage: args.includes('--reuse-image')
    });
    console.log(JSON.stringify({ resources: result.terraform.resources.length, image: result.image.digest, level: result.terraform.evidence_level }));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
