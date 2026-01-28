import { Ajv, ErrorObject, JSONSchemaType } from "ajv"

export const ajv = new Ajv()
export type { JSONSchemaType } from "ajv"

export class Validator {
    constructor(private ajv: Ajv) {

    }

    public validate<T>(schema: JSONSchemaType<T>, data: unknown): typeof data extends T ? null : ErrorObject[] {
        const validate = this.ajv.compile(schema)
        validate(data)
        
        if (validate.errors?.length) {
            return validate.errors as typeof data extends T ? null : ErrorObject[]
        }
        return null as typeof data extends T ? null : ErrorObject[]
    }
}

export const defaultValidator = new Validator(ajv)
