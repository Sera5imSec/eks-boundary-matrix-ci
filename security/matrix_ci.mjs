import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CATALOG, BINDINGS, DECISIONS, readJson, writeJson, argument, isMain, selectedIds } from './matrix_lib.mjs';
import { filesIn, isSource, sourceUnits, impactReport } from './change_impact.mjs';
import { candidates, reviewImpact, selectMatrices } from './boundary_review.mjs';
import { oracleIds } from './matrix_oracles.mjs';
import { negativeCaseIds, runCases } from './matrix_cases.mjs';
import { verifyFreshness } from './matrix_runtime.mjs';
import { prepareEvidence } from './prepare_evidence.mjs';
import { createReport, markdownReport, saveReport } from './matrix_report.mjs';

export function validateCatalog(root = ROOT) {
  const catalog = readJson(CATALOG, root);
  const bindings = readJson(BINDINGS, root);
  const decisions = readJson(DECISIONS, root);
  const errors = [];
  const ids = catalog.matrices.map(matrix => matrix.id);
  const cases = catalog.matrices.flatMap(matrix => matrix.variants.map(variant => variant.id));
  const inventory = filesIn(root).filter(isSource).flatMap(file => sourceUnits(file, fs.readFileSync(path.join(root, file), 'utf8')));
  if (catalog.schema_version !== 1 || new Set(ids).size !== ids.length || new Set(cases).size !== cases.length) errors.push('Catalog schema or IDs are invalid');
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...oracleIds].sort())) errors.push('Every matrix needs one implemented oracle');
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...bindings.bound_matrices].sort())) errors.push('Bound matrix list differs from catalog');
  for (const matrix of catalog.matrices) {
    if (!matrix.boundary || !matrix.obligation || !matrix.evidence?.ci) errors.push(matrix.id + ': incomplete obligation or evidence');
    if (!matrix.variants.some(variant => variant.kind === 'positive') || !matrix.variants.some(variant => variant.kind === 'negative')) errors.push(matrix.id + ': missing control or negative case');
    for (const variant of matrix.variants) {
      if (bindings.scenario_to_matrix[variant.id] !== matrix.id) errors.push(variant.id + ': scenario binding is invalid');
      if (variant.kind === 'negative' && !negativeCaseIds.includes(variant.id)) errors.push(variant.id + ': missing executable fixture');
    }
  }
  const declaredNegatives = catalog.matrices.flatMap(matrix => matrix.variants.filter(variant => variant.kind === 'negative').map(variant => variant.id));
  if (JSON.stringify([...declaredNegatives].sort()) !== JSON.stringify([...negativeCaseIds].sort())) errors.push('The negative fixture registry differs from the catalog');
  if (Object.keys(bindings.scenario_to_matrix).length !== cases.length) errors.push('Orphan scenario bindings exist');
  for (const source of bindings.sources) {
    if (!isSource(source.path) || !fs.existsSync(path.join(root, source.path))) errors.push('Source binding is stale: ' + source.path);
    if (!source.symbol_prefixes.length || source.matrix_ids.some(id => !ids.includes(id))) errors.push('Invalid source binding: ' + source.path);
    for (const prefix of source.symbol_prefixes) {
      if (!inventory.some(unit => unit.path === source.path && unit.symbol.startsWith(prefix))) errors.push('Source binding has no current code unit: ' + source.path + ':' + prefix);
    }
  }
  const uniqueDecisions = new Set();
  for (const row of decisions.decisions) {
    const key = row.path + ':' + row.symbol + ':' + row.fingerprint + ':' + (row.change ?? '');
    if (uniqueDecisions.has(key)) errors.push('Duplicate coverage decision: ' + row.path + ':' + row.symbol);
    uniqueDecisions.add(key);
    if (!/^[0-9a-f]{64}$/.test(row.fingerprint)) errors.push('Coverage fingerprint is invalid');
    if (!row.path || !row.symbol || typeof row.reason !== 'string' || !row.reason.trim() ||
        !Array.isArray(row.matrix_ids) || !Array.isArray(row.variant_ids) ||
        !['existing_rule', 'add_variant', 'new_matrix', 'not_security'].includes(row.decision)) errors.push('Malformed coverage decision');
  }
  if (!errors.length) {
    const reverse = reviewImpact({ changed_units: inventory.map(unit => ({ ...unit, status: 'current' })) }, catalog, bindings, decisions);
    errors.push(...reverse.errors);
  }
  return { schema_version: 1, status: errors.length ? 'FAIL' : 'PASS', matrices: ids.length, scenarios: cases.length,
    source_units: inventory.length, errors };
}

export function reviewSource(options = {}) {
  const root = options.root ?? ROOT;
  const output = path.join(root, 'artifacts');
  fs.mkdirSync(output, { recursive: true });
  let validation;
  let impact;
  let review;
  let catalog;
  let bindings;
  try { validation = validateCatalog(root); }
  catch (error) { validation = { schema_version: 1, status: 'ERROR', errors: [error.message] }; }
  writeJson(path.join(output, 'catalog-validation.json'), validation);
  try { impact = impactReport({ root, full: options.full, base: options.base }); }
  catch (error) {
    impact = { schema_version: 1, mode: 'error', status: 'ERROR', changed_files: [], changed_units: [], errors: [error.message] };
  }
  writeJson(path.join(output, 'change-impact.json'), impact);
  try {
    catalog = readJson(CATALOG, root);
    bindings = readJson(BINDINGS, root);
    if (impact.status === 'ERROR') throw new Error('Source change analysis failed; changed units could not be reviewed');
    review = reviewImpact(impact, catalog, bindings, readJson(DECISIONS, root));
  } catch (error) { review = { schema_version: 1, status: 'ERROR', rows: [], errors: [error.message] }; }
  writeJson(path.join(output, 'boundary-review.json'), review);
  const errors = [...new Set([...validation.errors, ...(impact.errors ?? []), ...review.errors])];
  const selection = errors.length
    ? { schema_version: 1, mode: 'blocked', matrix_ids: [], reason: 'Source review must pass before runtime selection' }
    : selectMatrices(impact, catalog, bindings, review);
  writeJson(path.join(output, 'matrix-selection.json'), selection);
  const result = {
    schema_version: 1, status: errors.length ? 'FAIL' : 'PASS', phase: 'SOURCE_REVIEW',
    coverage_status: review.status, changed_files: impact.changed_files.length,
    changed_units: impact.changed_units.length, source_units: validation.source_units ?? null,
    oracle_execution: 'NOT_RUN', errors
  };
  writeJson(path.join(output, 'source-review.json'), result);
  const cell = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  const changes = new Map(impact.changed_units.map(unit => [JSON.stringify([unit.path, unit.symbol]), unit.status]));
  const markdown = [
    '# Source coverage review', '',
    '**' + result.status + '** — source review only; build and matrix oracles have not run.', '',
    'Changed units: ' + result.changed_units + '. Current inventory: ' + (result.source_units ?? 'unknown') + '.', '',
    '| Path | Symbol | Change | Before SHA-256 | Current / deleted SHA-256 | Candidate matrices | Decision | Review |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...review.rows.map(row => '| ' + [row.path, row.symbol, changes.get(JSON.stringify([row.path, row.symbol])),
      row.before_fingerprint, row.fingerprint, row.candidate_matrix_ids.join(', '), row.decision, row.detail].map(cell).join(' | ') + ' |'),
    '', ...errors.map(error => '- ' + cell(error)), '',
    'For unresolved coverage, ask the Boundary Coverage agent (or @copilot on this PR) to review the diff using AGENTS.md.',
    'Candidate IDs are suggestions from recorded bindings, not proof that the scenarios are sufficient.',
    'Review the proposed changes before allowing workflows and merging. Do not renew fingerprints without a coverage rationale.', ''
  ].join('\n');
  fs.writeFileSync(path.join(output, 'source-review.md'), markdown);
  if (options.summary !== false && process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  // Replace old results before any build, including failed preflights in a reused local checkout.
  writeJson(path.join(output, 'matrix-runtime.json'), { schema_version: 1, status: 'NOT_RUN', matrices: [] });
  const pending = { schema_version: 1, status: errors.length ? 'FAIL' : 'NOT_RUN', phase: 'SOURCE_REVIEW',
    selection: selection.mode, rows: [], errors, evidence_scope: 'Source coverage only; build and matrix oracles were not run',
    deployed_aws_and_kubernetes: 'PENDING' };
  writeJson(path.join(output, 'matrix-status.json'), pending);
  fs.writeFileSync(path.join(output, 'matrix-status.md'), markdownReport(pending));
  return { ...result, impact, review, selection };
}

export async function runGate(options = {}) {
  const root = options.root ?? ROOT;
  const output = path.join(root, 'artifacts');
  fs.mkdirSync(output, { recursive: true });
  let selection;
  let review;
  let runtime;
  try {
    const source = reviewSource({ ...options, summary: false });
    selection = source.selection;
    review = source.review;
    if (source.errors.length) {
      const report = readJson('artifacts/matrix-status.json', root);
      saveReport(report, output);
      return report;
    }
    const catalog = readJson(CATALOG, root);
    let evidence = null;
    if (selection.matrix_ids.length) {
      evidence = options.evidence ? readJson(options.evidence, root) : await prepareEvidence({ root, terraform: options.terraform ?? 'terraform' });
      verifyFreshness(evidence, root);
      runtime = runCases(catalog, selection.matrix_ids, evidence);
    } else runtime = { schema_version: 1, status: 'PASS', matrices: [] };
    writeJson(path.join(output, 'matrix-runtime.json'), runtime);
    const report = createReport(selection, review, runtime, catalog);
    saveReport(report, output);
    return report;
  } catch (error) {
    const report = createReport(selection, review, runtime);
    report.status = 'FAIL';
    report.errors.push(error.message);
    saveReport(report, output);
    return report;
  }
}

if (isMain(import.meta)) {
  try {
    const args = process.argv.slice(2);
    const command = args[0];
    if (command === 'validate') {
      const report = validateCatalog();
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === 'PASS' ? 0 : 1;
    } else if (command === 'review') {
      const report = reviewSource({ full: args.includes('--full'), base: argument(args, '--base') });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === 'PASS' ? 0 : 1;
    } else if (command === 'run') {
      const report = await runGate({ full: args.includes('--full'), base: argument(args, '--base'),
        evidence: argument(args, '--evidence'), terraform: argument(args, '--terraform', 'terraform') });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === 'PASS' ? 0 : 1;
    } else if (command === 'select') {
      const impact = readJson(argument(args, '--impact', 'artifacts/change-impact.json'));
      const review = reviewImpact(impact, readJson(CATALOG), readJson(BINDINGS), readJson(DECISIONS));
      const selection = selectMatrices(impact, readJson(CATALOG), readJson(BINDINGS), review);
      writeJson(argument(args, '--output', 'artifacts/matrix-selection.json'), selection);
      console.log(JSON.stringify(selection));
    } else if (command === 'resolve') {
      console.log(JSON.stringify(selectedIds(readJson(CATALOG), argument(args, '--matrix', 'all'))));
    } else throw new Error('Use validate, review, run, select or resolve');
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
