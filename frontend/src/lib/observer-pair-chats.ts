import type { ObserverChatMessage } from "./observer-conversation";

export interface ObserverPairChat {
  messages: ObserverChatMessage[];
  unread: number;
}
export type ObserverPairChats = Record<string, ObserverPairChat>;
export const OBSERVER_CHAT_MESSAGE_LIMIT = 120;

/** Each pair keeps its own bounded history; activity elsewhere cannot evict it. */
export function appendObserverPairMessages(previous: ObserverPairChats, additions: ObserverChatMessage[], readingPair: string | null): ObserverPairChats {
  if (!additions.length) return previous;
  const next = { ...previous };
  for (const message of additions) {
    const chat = next[message.instrument] ?? { messages: [], unread: 0 };
    next[message.instrument] = {
      messages: [...chat.messages, message].slice(-OBSERVER_CHAT_MESSAGE_LIMIT),
      unread: Math.min(OBSERVER_CHAT_MESSAGE_LIMIT, chat.unread + (message.role === "observer" && readingPair !== message.instrument ? 1 : 0)),
    };
  }
  return next;
}

export function markObserverPairRead(previous: ObserverPairChats, instrument: string): ObserverPairChats {
  const chat = previous[instrument];
  if (!chat?.unread) return previous;
  return { ...previous, [instrument]: { ...chat, unread: 0 } };
}
