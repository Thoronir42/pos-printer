import { Buffer } from "node:buffer";
import { getPrinter } from "../utils/printer.ts";
import { command, create } from "@md/cli";

type CutTest = {
    label: string,
    bytes: number[],
};

// Every known ESC/POS paper-cut command. The printer should perform a cut right
// after the matching label, so whichever label ends up at a cut boundary tells
// us which command this printer actually honors.
const CUT_TESTS: CutTest[] = [
    { label: "1: GS V 0   (full cut)", bytes: [0x1d, 0x56, 0x00] },
    { label: "2: GS V 1   (partial cut)", bytes: [0x1d, 0x56, 0x01] },
    { label: "3: GS V 48  (full cut, '0')", bytes: [0x1d, 0x56, 0x30] },
    { label: "4: GS V 49  (partial cut, '1')", bytes: [0x1d, 0x56, 0x31] },
    { label: "5: GS V 65 0  (feed+full cut)", bytes: [0x1d, 0x56, 0x41, 0x00] },
    { label: "6: GS V 65 60 (feed 60+full cut)", bytes: [0x1d, 0x56, 0x41, 0x3c] },
    { label: "7: GS V 66 0  (feed+partial cut)", bytes: [0x1d, 0x56, 0x42, 0x00] },
    { label: "8: GS V 66 60 (feed 60+partial)", bytes: [0x1d, 0x56, 0x42, 0x3c] },
    { label: "9: ESC i    (full cut, legacy)", bytes: [0x1b, 0x69] },
    { label: "10: ESC m   (partial cut, legacy)", bytes: [0x1b, 0x6d] },
];

function writeRaw(printer: { buffer: { write: (data: Buffer) => void } }, bytes: number[]) {
    printer.buffer.write(Buffer.from(bytes));
}

function flush(printer: { flush: (cb: (err?: Error | null) => void) => void }) {
    return new Promise<void>((resolve, reject) => {
        printer.flush((err) => (err ? reject(err) : resolve()));
    });
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const cmd = command({
    description: "Fire every known ESC/POS cut command with a label before each, to find which one the printer honors",
    arguments: [],
    flags: {},
}).runner(async () => {
    const printer = await getPrinter();
    if (!printer) {
        throw new Error("No printer found");
    }

    printer.encode("CP437");

    for (const test of CUT_TESTS) {
        // deno-lint-ignore no-explicit-any
        const raw = printer as any;
        printer
            .align("LT")
            .text(test.label)
            .feed(4);
        writeRaw(raw, test.bytes);
        await flush(raw);
        // Give the printer time to process the cut before the next label.
        await delay(1500);
    }

    // deno-lint-ignore no-explicit-any
    const raw = printer as any;
    printer.align("CT").text("--- end of cut test ---").feed(5);
    await flush(raw);
    printer.close();
    console.log("Done. Tell me which label number is at a cut.");
});

if (import.meta.main) {
    create("test-cut-cli", { cmd }).run(["cmd", ...Deno.args]);
}
