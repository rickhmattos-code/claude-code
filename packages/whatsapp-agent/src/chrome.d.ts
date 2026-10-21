// Minimal ambient declarations for the Chrome extension APIs this package
// uses. Kept local so the root project does not need @types/chrome.
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: { id?: number; url?: string }
    }
    function sendMessage<T = unknown>(message: unknown): Promise<T>
    function openOptionsPage(): Promise<void>
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | undefined,
      ): void
    }
  }
  namespace storage {
    const local: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
    }
  }
}
