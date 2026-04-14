import { command, create } from "@md/cli";

export const cmd = command({
    description: "Run the server",
    arguments: [],
    flags: {
        port: { type: 'value', description: 'Port to run the server on', },
    },
}).runner(async (_arguments, flags) => {
    const { app } = await import("../app.ts");
    
    const port = Number(flags.port) || 3639;

    app.addEventListener("listen", (e) => {
        console.log(`Server running on http://${e.hostname}:${e.port}/`);
    });

    return app.listen({
        port,
    })
})

if (import.meta.main) {
    create('serve', { cmd }).run(['cmd', ...Deno.args])
}
