import chalk from "chalk";
import boxen from "boxen";
const title = chalk.bold.hex("#ff0000c0")("ARNIM ZOLA") + chalk.dim(` v${1.0}`);
const subtitle = chalk.cyan("A light-weight open-source AI code agent powered by Groq LLM");
const info = [
    `${chalk.dim("Active Model:")} ${chalk.green(1.0)}`,
    `${chalk.dim("Commands:")} Type ${chalk.yellow("/help")} for available commands or ${chalk.yellow("/exit")} to quit.`,
].join("\n");

const boxed = boxen(`${title}\n${subtitle}\n\n${info}`, {
    padding: 1,
    margin: { top: 0, bottom: 1, left: 0, right: 0 },
    borderStyle: "round",
    borderColor: "#c25aff",
    textAlignment: "left",
});

console.log(boxed);