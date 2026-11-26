import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cleanupRoots, harness } from "./support.ts";
import { FILTERS, layoutOf, oracle, paged, paramsOf, unusableDb } from "./oracle-support.ts";

/**
 * specs/search-tool.md#candidates, specs/search-tool.md#matching, specs/search-tool.md#evaluation
 * and specs/search-tool.md#result: `find` agrees with the oracle over every combination of
 * filters, orders, branches, index states and page sizes, one test per scope.
 */

after(cleanupRoots);

for (const scope of ["session", "tree", "project", "project-trees"]) {
  test(`the oracle and find agree over the matrix in scope ${scope}: filters, orders, branches, paging, index states`, async () => {
    const made = layoutOf("search-tool-oracle-");
    const unusable = unusableDb(made.db);
    let runs = 0;
    for (const { label, filters } of FILTERS) {
      for (const order of ["newest", "oldest"] as const) {
        for (const branches of [false, true]) {
          for (const db of [made.db, unusable]) {
            for (const limit of [7, 100]) {
              const h = harness({ db });
              const params: Record<string, unknown> = {
                ...paramsOf(filters),
                action: "find",
                scope,
                order,
                branches,
              };
              const actual = await paged(h, made.host, params, limit);
              const expected = oracle(
                made.layout,
                scope,
                { ...filters, order, branches },
                Number.MAX_SAFE_INTEGER,
              );
              assert.deepEqual(
                actual,
                expected,
                `${scope} / ${label} / ${order} / branches ${branches} / ${db === made.db ? "index" : "direct"} / limit ${limit}`,
              );
              runs += 1;
            }
          }
        }
      }
    }
    assert.equal(runs, 256);
  });
}
