export type ChatMessage = { id: string; workspaceId: string; message: string; createdAt: string; user: { id: string; username: string } };
export function mergeMessages(previous: ChatMessage[], incoming: ChatMessage[]) {
  return [...new Map([...previous, ...incoming].map(message => [message.id, message])).values()]
    .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
