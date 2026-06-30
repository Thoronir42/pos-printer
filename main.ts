import * as bot from "./src/bin/bot.ts";
import * as botExplore from "./src/bin/bot-explore.ts";
import * as botRewind from "./src/bin/bot-rewind.ts";
import * as debugEncofings from "./src/bin/debug-encodings.ts";
import * as serve from "./src/bin/serve.ts";
import * as testCut from "./src/bin/test-cut.ts";

import { create } from "@md/cli";

create("pp", {
  bot: bot.cmd,
  "bot-explore": botExplore.cmd,
  "bot-rewind": botRewind.cmd,
  "debug-encodings": debugEncofings.cmd,
  serve: serve.cmd,
  "test-cut": testCut.cmd,
})
  .run();
