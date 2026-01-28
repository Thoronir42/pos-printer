import { AppError } from "../AppError.ts";
import { defineAction } from "../dataDriven/actionRunner.ts";
import { getPrinter } from "../printer.ts";

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

        // Some adapters such as USB do not support reading status
        if (!printer.adapter.read) {
            return {staus: 'online', statuses: []}
        }

        const statuses = await new Promise((res) => printer.getStatuses((result: unknown[]) => res(result)))
        return { status: 'online', statuses }
    },
})
