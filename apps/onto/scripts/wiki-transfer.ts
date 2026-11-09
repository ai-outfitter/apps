/** Keep the package transfer command on the same ordinary HTTP client. */
import { runWikiTransfer } from "./wiki-transfer.mjs";
await runWikiTransfer(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
