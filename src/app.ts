import fs from "node:fs";
import { Application, Router } from "@oak/oak";
import { defaultValidator } from "./validation.ts";
import { Action, ActionRunner } from "./dataDriven/actionRunner.ts";


const actions: Record<string, Action<object>> = {};
for (const taskFile of fs.readdirSync(import.meta.dirname + "/printTasks")) {
  const name = taskFile.replace(/\.ts$/, "");
  actions[name] = await import(`./printTasks/${taskFile}`).then((mod) =>
    mod.default
  );
}

const actionRunner = new ActionRunner(defaultValidator);

const router = new Router();

const validMethods = new Set(["get", "post", "put", "delete", "patch"]);
function isValidMethod(method: string): method is "get" | "post" | "put" | "delete" | "patch" {
  return validMethods.has(method.toLowerCase());
}

for (const [name, action] of Object.entries(actions)) {
  const parts = name.split(".");
  const routeName = parts[0]
  const method = parts[1] || "post"
  if (!isValidMethod(method)) {
    throw new Error(`Invalid method "${method}" for action "${name}"`)
  }

  router[method](`/${routeName}`, async (ctx) => {
    const result = await actionRunner.runAction(action, ctx.request);
    ctx.response.status = result.status;
    ctx.response.body = result.body;
  });
}

export const app = new Application()

app.use((ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");

  const requestedHeaders = ctx.request.headers.get("access-control-request-headers");
  ctx.response.headers.set(
    "Access-Control-Allow-Headers",
    requestedHeaders ?? "Content-Type",
  );

  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 204;
    return;
  }

  return next()
})

app.use(router.routes());
app.use(router.allowedMethods());
