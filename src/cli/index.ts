import { capture } from "./capture.ts";
import { doctor } from "./doctor.ts";
import { scan } from "./scan.ts";
import { resolve } from "./resolve.ts";
import { report } from "./report.ts";

const USAGE = `
poly - measure whether Claude has forecasting edge over Polymarket

  npm run doctor              check config, credentials, and both APIs
  npm run capture             save live Gamma/CLOB payloads to test/fixtures/
  npm run scan                screen markets, forecast, open paper positions
  npm run scan -- --dry-run   show what would be forecast, spend nothing
  npm run scan -- --limit 5   cap this run at 5 forecasts
  npm run resolve             settle paper positions on resolved markets
  npm run report              calibration, edge test, and paper P&L

Everything is tunable via environment variables - see .env.example.
`;

async function main(): Promise<number> {
  const [command = "", ...rest] = process.argv.slice(2);

  switch (command) {
    case "doctor":
      return doctor();
    case "capture":
      return capture(rest);
    case "scan":
      return scan(rest);
    case "resolve":
      return resolve();
    case "report":
      return report();
    case "":
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`\n  ${String(err)}\n`);
    process.exitCode = 1;
  });
