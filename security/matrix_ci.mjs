import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CATALOG, BINDINGS, DECISIONS, readJson, writeJson, argument, isMain, selectedIds } from './matrix_lib.mjs';
import { filesIn, isSource, sourceUnits, impactReport } from './change_impact.mjs';
import { candidates, reviewImpact, selectMatrices } from './boundary_review.mjs';
import { oracleIds } from './matrix_oracles.mjs';
import { negativeCaseIds, runCases } from './matrix_cases.mjs';
import { verifyFreshness } from './matrix_runtime.mjs';
import { prepareEvidence } from './prepare_evidence.mjs';
import { createReport, saveReport } from './matrix_report.mjs';

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

export async function runGate(options = {}) {
  const root = options.root ?? ROOT;
  const output = path.join(root, 'artifacts');
  fs.mkdirSync(output, { recursive: true });
  let selection;
  let review;
  let runtime;
  try {
    const validation = validateCatalog(root);
    writeJson(path.join(output, 'catalog-validation.json'), validation);
    if (validation.errors.length) throw new Error(validation.errors.join('\n'));
    const catalog = readJson(CATALOG, root);
    const bindings = readJson(BINDINGS, root);
    const impact = impactReport({ root, full: options.full, base: options.base });
    writeJson(path.join(output, 'change-impact.json'), impact);
    review = reviewImpact(impact, catalog, bindings, readJson(DECISIONS, root));
    writeJson(path.join(output, 'boundary-review.json'), review);
    selection = selectMatrices(impact, catalog, bindings, review);
    writeJson(path.join(output, 'matrix-selection.json'), selection);
    let evidence = null;
    if (selection.matrix_ids.length) {
      evidence = options.evidence ? readJson(options.evidence, root) : await prepareEvidence({ root, terraform: options.terraform ?? 'terraform' });
      verifyFreshness(evidence, root);
      runtime = runCases(catalog, selection.matrix_ids, evidence);
    } else runtime = { schema_version: 1, status: 'PASS', matrices: [] };
    writeJson(path.join(output, 'matrix-runtime.json'), runtime);
    const report = createReport(selection, review, runtime);
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
    } else throw new Error('Use validate, run, select or resolve');
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
