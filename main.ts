import * as debugEncofings from "./src/bin/debug-encodings.ts";
import * as serve from "./src/bin/serve.ts";

import { create } from "@md/cli";

create("pp", {
  "debug-encodings": debugEncofings.cmd,
  serve: serve.cmd,
})
  .run();
