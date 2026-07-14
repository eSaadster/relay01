import chalk from "chalk";
import { Command } from "commander";
import { info, setVerbose, success, danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";

export function buildProgram() {
  const program = new Command();
  const PROGRAM_VERSION = VERSION;
  const TAGLINE = "Slack bot powered by pi-agent";

  program
    .name("relay01")
    .description("Slack bot CLI powered by pi-agent")
    .version(PROGRAM_VERSION);

  const formatIntroLine = (version: string, rich = true) => {
    const base = `🤖 relay01 ${version} — ${TAGLINE}`;
    return rich && chalk.level > 0
      ? `${chalk.bold.cyan("🤖 relay01")} ${chalk.white(version)} ${chalk.gray("—")} ${chalk.green(TAGLINE)}`
      : base;
  };

  program.configureHelp({
    optionTerm: (option) => chalk.yellow(option.flags),
    subcommandTerm: (cmd) => chalk.green(cmd.name()),
  });

  program.configureOutput({
    writeOut: (str) => {
      const colored = str
        .replace(/^Usage:/gm, chalk.bold.cyan("Usage:"))
        .replace(/^Options:/gm, chalk.bold.cyan("Options:"))
        .replace(/^Commands:/gm, chalk.bold.cyan("Commands:"));
      process.stdout.write(colored);
    },
    writeErr: (str) => process.stderr.write(str),
    outputError: (str, write) => write(chalk.red(str)),
  });

  if (process.argv.includes("-V") || process.argv.includes("--version")) {
    console.log(formatIntroLine(PROGRAM_VERSION));
    process.exit(0);
  }

  program.addHelpText("beforeAll", `\n${formatIntroLine(PROGRAM_VERSION)}\n`);
  const examples = [
    [
      "relay01 start ./data",
      "Start Slack bot with data directory ./data",
    ],
    [
      "relay01 start --verbose ./data",
      "Start with verbose logging",
    ],
  ] as const;

  const fmtExamples = examples
    .map(([cmd, desc]) => `  ${chalk.green(cmd)}\n    ${chalk.gray(desc)}`)
    .join("\n");

  program.addHelpText(
    "afterAll",
    `\n${chalk.bold.cyan("Examples:")}\n${fmtExamples}\n`,
  );

  program
    .command("start")
    .description("Start the Slack bot")
    .argument("<working-dir>", "Directory for channel data and attachments")
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  relay01 start ./data                # start bot with ./data as working dir
  relay01 start --verbose ./data      # with detailed logging

Environment variables required:
  SLACK_APP_TOKEN    Slack app token (xapp-...)
  SLACK_BOT_TOKEN    Slack bot token (xoxb-...)

Optional environment variables:
  PI_AGENT_MODEL     Model to use (set in ~/relay01/slack/.env)
  PI_THINKING_LEVEL  Thinking level: off, minimal, low, medium, high (default: off)
  PI_TIMEOUT_MS      Timeout in milliseconds (default: 120000)
`,
    )
    .action(async (workingDir, opts) => {
      setVerbose(Boolean(opts.verbose));

      // Import and run the slack main module
      process.argv = ["node", "relay01", workingDir];

      try {
        await import("../slack/main.js");
      } catch (err) {
        defaultRuntime.error(danger(`Failed to start Slack bot: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("status")
    .description("Show bot status and active sessions")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));

      // For now, just show environment status
      const appToken = process.env.SLACK_APP_TOKEN || process.env.MOM_SLACK_APP_TOKEN;
      const botToken = process.env.SLACK_BOT_TOKEN || process.env.MOM_SLACK_BOT_TOKEN;

      defaultRuntime.log(info("Environment check:"));
      defaultRuntime.log(
        appToken
          ? success("  ✓ SLACK_APP_TOKEN is set")
          : danger("  ✗ SLACK_APP_TOKEN is not set")
      );
      defaultRuntime.log(
        botToken
          ? success("  ✓ SLACK_BOT_TOKEN is set")
          : danger("  ✗ SLACK_BOT_TOKEN is not set")
      );

      const model = process.env.PI_AGENT_MODEL || "(not set)";
      defaultRuntime.log(info(`  Model: ${model}`));
    });

  return program;
}
