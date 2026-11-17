import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, writeJson, argument, CATALOG, BINDINGS, DECISIONS, isMain } from './matrix_lib.mjs';

export function candidates(unit, bindings) {
  const matches = bindings.sources.filter(source => source.path === unit.path &&
    source.symbol_prefixes.some(prefix => unit.symbol.startsWith(prefix)));
  return [...new Set(matches.flatMap(source => source.matrix_ids))];
}

export function reviewImpact(impact, catalog, bindings, decisions) {
  const matrices = new Map(catalog.matrices.map(matrix => [matrix.id, matrix]));
  const errors = [];
  const rows = impact.changed_units.map(unit => {
    const decision = decisions.decisions.find(row => row.path === unit.path && row.symbol === unit.symbol &&
      row.fingerprint === unit.fingerprint && (unit.status === 'deleted' ? row.change === 'deleted' : row.change !== 'deleted'));
    const candidateIds = candidates(unit, bindings);
    let issue = null;
    if (!decision) issue = 'A source coverage decision is required';
    else if (!['existing_rule', 'add_variant', 'new_matrix', 'not_security'].includes(decision.decision) || !decision.reason?.trim()) issue = 'Invalid coverage decision';
    else if (decision.decision === 'not_security') {
      if (decision.matrix_ids.length || decision.variant_ids.length) issue = 'A non-security decision cannot claim scenario coverage';
    } else {
      if (!decision.matrix_ids.length || !decision.variant_ids.length) issue = 'A security decision needs matrices and scenarios';
      for (const id of decision.matrix_ids) {
        const matrix = matrices.get(id);
        if (!matrix || !decision.variant_ids.some(variant => matrix.variants.some(row => row.id === variant))) issue = 'Matrix/scenario reference is invalid';
      }
      for (const id of decision.variant_ids) {
        if (!decision.matrix_ids.some(matrix => matrices.get(matrix)?.variants.some(row => row.id === id))) issue = 'Scenario is outside the named matrices';
      }
      if (impact.base_catalog) {
        const before = new Map(impact.base_catalog.map(matrix => [matrix.id, matrix]));
        if (decision.decision === 'new_matrix' && !decision.matrix_ids.some(id => !before.has(id))) issue = 'The decision names no newly added matrix';
        if (decision.decision === 'add_variant') {
          const previous = new Set(decision.matrix_ids.flatMap(id => before.get(id)?.variant_ids ?? []));
          if (!decision.variant_ids.some(id => !previous.has(id))) issue = 'The decision names no newly added scenario';
        }
      }
    }
    if (issue) errors.push(unit.path + ':' + unit.symbol + ': ' + issue);
    return { ...unit, candidate_matrix_ids: candidateIds, decision: decision?.decision ?? null,
      matrix_ids: decision?.matrix_ids ?? [], status: issue ? 'REVIEW_REQUIRED' : 'REVIEWED', detail: issue ?? decision.reason };
  });
  return { schema_version: 1, errors, rows, status: errors.length ? 'REVIEW_REQUIRED' : 'PASS' };
}

export function selectMatrices(impact, catalog, bindings, review) {
  const all = catalog.matrices.map(matrix => matrix.id);
  if (impact.mode === 'full') return { schema_version: 1, mode: 'full', matrix_ids: all, reason: 'Full run requested' };
  const engineChanged = impact.changed_files.some(file =>
    file.startsWith('security/') && file !== DECISIONS || ['package.json', 'package-lock.json'].includes(file) ||
    file === '.github/workflows/ci.yml' || file === '.github/workflows/matrix-sensitivity.yml');
  if (engineChanged || review.errors.length) return { schema_version: 1, mode: 'full', matrix_ids: all, reason: engineChanged ? 'Gate configuration changed' : 'Unclassified source change' };
  const selected = new Set(review.rows.flatMap(row => [...row.candidate_matrix_ids, ...row.matrix_ids]));
  const changedSourceFiles = new Set(impact.changed_units.map(unit => unit.path));
  for (const file of impact.changed_files) {
    if (!changedSourceFiles.has(file)) continue;
    const mapped = bindings.sources.filter(source => source.path === file);
    if (!mapped.length) return { schema_version: 1, mode: 'full', matrix_ids: all, reason: 'New source file needs review' };
  }
  return { schema_version: 1, mode: 'incremental', matrix_ids: all.filter(id => selected.has(id)), reason: 'Source blocks and recorded coverage decisions' };
}

if (isMain(import.meta)) {
  try {
    const args = process.argv.slice(2);
    const report = reviewImpact(readJson(argument(args, '--impact', 'artifacts/change-impact.json')),
      readJson(CATALOG), readJson(BINDINGS), readJson(DECISIONS));
    writeJson(argument(args, '--output', 'artifacts/boundary-review.json'), report);
    console.log(JSON.stringify({ status: report.status, units: report.rows.length, unresolved: report.errors.length }));
    process.exitCode = report.errors.length ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
