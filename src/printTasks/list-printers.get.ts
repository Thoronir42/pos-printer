import { defineAction } from "../dataDriven/actionRunner.ts";
import { listPrinters } from "../utils/printer.ts";

export default defineAction({
    schema: {
        type: "object",
        required: [],
    },
    run: async () => {
        return {
            printers: await listPrinters(),
        };
    },
});
