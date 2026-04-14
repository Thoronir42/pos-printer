import { AppError } from "../AppError.ts";
import { defineAction } from "../dataDriven/actionRunner.ts";
import { getPrinter } from "../utils/printer.ts";

type StatusCapablePrinter = {
    adapter?: {
        read?: unknown,
    },
    getStatuses?: (cb: (result: unknown[]) => void) => void,
}

export default defineAction({
    schema: {
        type: "object",
        required: [],
    },
    run: async () => {
        const printer = await getPrinter()
        if (!printer) {
            throw new AppError('not-found', {subject: 'printer'})
        }

        const statusPrinter = printer as unknown as StatusCapablePrinter

        // Some adapters such as USB do not support reading status
        if (!statusPrinter.adapter?.read || !statusPrinter.getStatuses) {
            return { status: 'online', statuses: [] }
        }

        const statuses = await new Promise<unknown[]>((res) => statusPrinter.getStatuses?.((result: unknown[]) => res(result)))
        return { status: 'online', statuses }
    },
})
