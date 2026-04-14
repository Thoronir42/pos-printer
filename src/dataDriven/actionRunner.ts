import { Request } from "@oak/oak";
import { AppError } from "../AppError.ts";
import { JSONSchemaType, Validator } from "../validation.ts";

export class ActionRunner {
    constructor(private validator: Validator) {

    }

    public async runAction<Params extends object, Result extends object|void = void>(
        action: Action<Params, Result>,
        req: Request,
    ): Promise<Response> {
        let params = {}
        if (req.headers.get("content-type")?.includes("application/json")) {
            params = await req.body.json()
        }
        const errors = this.validator.validate(action.schema, params)
        if (errors) {
            return new Response(JSON.stringify({
            error: "invalid-data",
            details: errors,
            }), { status: 400 })
        }

        try {
            const result = await action.run(params as Params)
            return new Response(JSON.stringify(result), { status: 200 })
        } catch (e) {
            if (e instanceof AppError) {
                if (e.code === "not-found") {
                    return new Response(JSON.stringify({
                        error: e.code,
                        details: e.details,
                    }), { status: 404 })
                }
                if (e.code === "access-denied") {
                    return new Response(JSON.stringify({
                        error: e.code,
                        details: e.details,
                    }), { status: 423 })
                }
            }
            console.error("Action error:", e)
            return new Response("Internal Server Error", { status: 500 })
        }
    }
}

export type Action<Params extends object, Result extends ActionResult = void> = {
    schema: JSONSchemaType<Params>,
    run: (params: Params) => Promise<Result>,
}
type ActionResult = object | boolean | void

export function defineAction<Params extends object, Result extends ActionResult = void>(
    action: Action<Params, Result>,
): Action<Params, Result> {
    return action
}
