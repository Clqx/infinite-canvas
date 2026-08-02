import { upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { createUserScopedLocalForage } from "@/services/local-user-profiles";
import type { AgentAttachment, AgentChatItem } from "@/stores/use-agent-store";

export type StoredAgentUserMessage = Pick<AgentChatItem, "id" | "text" | "attachments"> & { role: "user"; historyText: string };

const store = createUserScopedLocalForage({ name: "infinite-canvas", storeName: "agent_chat_messages" });
const indexKey = (threadId: string) => `thread:${threadId}`;
const messageKey = (threadId: string, messageId: string) => `message:${threadId}:${messageId}`;

export async function saveAgentUserMessage(threadId: string, message: StoredAgentUserMessage) {
    if (!message.attachments?.length) return;
    const attachments = await Promise.all((message.attachments || []).map(createThumbnail));
    await store.setItem(messageKey(threadId, message.id), { ...message, attachments });
    const ids = (await store.getItem<string[]>(indexKey(threadId))) || [];
    if (!ids.includes(message.id)) await store.setItem(indexKey(threadId), [...ids, message.id]);
}

export async function readAgentUserMessages(threadId: string) {
    const ids = (await store.getItem<string[]>(indexKey(threadId))) || [];
    return (await Promise.all(ids.map((id) => store.getItem<StoredAgentUserMessage>(messageKey(threadId, id))))).filter((item): item is StoredAgentUserMessage => Boolean(item));
}

export async function deleteAgentThreadMessages(threadIds: string[]) {
    await Promise.all(
        threadIds.map(async (threadId) => {
            const ids = (await store.getItem<string[]>(indexKey(threadId))) || [];
            await Promise.all(ids.map((id) => store.removeItem(messageKey(threadId, id))));
            await store.removeItem(indexKey(threadId));
        }),
    );
}

async function createThumbnail(attachment: AgentAttachment): Promise<AgentAttachment> {
    const dataUrl = Math.max(attachment.width, attachment.height) > 512 ? await upscaleDataUrl(attachment.dataUrl, { targetLongEdge: 512, algorithm: "high" }) : attachment.dataUrl;
    return { ...attachment, size: dataUrl.length, url: dataUrl, dataUrl };
}
