import { defaultValidator } from "./validation.ts";
import { Action, ActionRunner } from "./dataDriven/actionRunner.ts";
import fs from "node:fs";

const actions: Record<string, Action<object>> = {};
for (const taskFile of fs.readdirSync(import.meta.dirname + "/printTasks")) {
  const name = taskFile.replace(/\.ts$/, "");
  actions[name] = await import(`./printTasks/${taskFile}`).then((mod) =>
    mod.default
  );
}

const actionRunner = new ActionRunner(defaultValidator);

export function server(opts: { port: number }) {
  Deno.serve(opts, async (req) => {
    if (req.method === "GET") {
      return actionRunner.runAction(actions["status"], req);
    }

    if (req.method === "POST") {
      const printAction = actions["receipt-transfer"];
      return actionRunner.runAction(printAction, req);
    }

    return new Response("Not Found", { status: 404 });
  });
}
