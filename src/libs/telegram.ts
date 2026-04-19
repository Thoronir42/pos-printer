import { getImageMimeType } from "../utils/image.ts";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";

export type TelegramPhotoSize = {
    file_id: string,
    width: number,
    height: number,
    file_size?: number,
};

export type TelegramSticker = {
    file_id: string,
    width: number,
    height: number,
    is_animated: boolean,
    is_video: boolean,
    thumb?: TelegramPhotoSize,
    file_size?: number,
};

export type TelegramMessage = {
    message_id: number,
    chat?: {
        id: number,
    },
    photo?: TelegramPhotoSize[],
    sticker?: TelegramSticker,
};

export type TelegramUpdate = {
    update_id: number,
    message?: TelegramMessage,
    edited_message?: TelegramMessage,
};

export type TelegramFile = {
    file_id: string,
    file_path?: string,
    file_size?: number,
};

export type TelegramSendMessageResult = {
    message_id: number,
};

type TelegramApiResponse<Result> = {
    ok: boolean,
    result?: Result,
    description?: string,
    error_code?: number,
};

async function callTelegramApi<Result>(
    token: string,
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<Result> {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${token}/${method}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
    });

    if (!response.ok) {
        throw new Error(`Telegram API ${method} failed with HTTP ${response.status}`);
    }

    const body = await response.json() as TelegramApiResponse<Result>;
    if (!body.ok || body.result == null) {
        throw new Error(body.description ?? `Telegram API ${method} failed`);
    }

    return body.result;
}

export function getMe(token: string, signal?: AbortSignal) {
    return callTelegramApi<{ username?: string }>(token, "getMe", {}, signal);
}

export function getUpdates(
    token: string,
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
) {
    return callTelegramApi<TelegramUpdate[]>(token, "getUpdates", {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "edited_message"],
    }, signal);
}

export function getTelegramFile(token: string, fileId: string, signal?: AbortSignal) {
    return callTelegramApi<TelegramFile>(token, "getFile", { file_id: fileId }, signal);
}

export function sendTelegramMessage(
    token: string,
    chatId: number,
    text: string,
    opts?: {
        replyToMessageId?: number,
    },
    signal?: AbortSignal,
) {
    const payload: Record<string, unknown> = {
        chat_id: chatId,
        text,
    };

    if (opts?.replyToMessageId != null) {
        payload.reply_to_message_id = opts.replyToMessageId;
        payload.allow_sending_without_reply = true;
    }

    return callTelegramApi<TelegramSendMessageResult>(token, "sendMessage", payload, signal);
}

export async function downloadTelegramFile(token: string, filePath: string, signal?: AbortSignal) {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}/file/bot${token}/${filePath}`, {
        signal,
    });
    if (!response.ok) {
        throw new Error(`Telegram file download failed with HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    const mimeType = getImageMimeType(filePath, response.headers.get("content-type"));
    if (!mimeType) {
        throw new Error("Unsupported Telegram image type");
    }

    return {
        buffer,
        mimeType,
    };
}
