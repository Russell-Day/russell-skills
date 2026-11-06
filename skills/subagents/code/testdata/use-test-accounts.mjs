// Imported first by every test file: the scripts under test (and the processes they
// spawn, which inherit the env) read the fixed test accounts, not this machine's.
import path from "node:path";
import { fileURLToPath } from "node:url";
process.env.ACCOUNTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "accounts.test.json");
