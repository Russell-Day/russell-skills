// Prints the DDL of the statev2.sqlite tables t3-api.mjs reads (for testdata/statev2-schema.sql).
import { t3Query, t3Tables } from "../t3-api.mjs";

console.log("-- The statev2.sqlite tables t3-api.mjs reads, as T3 0.1.0 created them; testdata/fake-t3.mjs builds");
console.log("-- its test DB from this. Regenerate after a T3 update: node testdata/dump-schema.mjs > testdata/statev2-schema.sql");
for (const table of Object.keys(t3Tables)) {
  for (const { sql } of t3Query("select sql from sqlite_master where tbl_name=? and sql is not null order by type desc", [table])) console.log(`${sql};`);
}
