import { Notice } from "obsidian";

export function cortexNotice(message: string, duration?: number) {
  new Notice("cortex: " + message, duration ? duration : undefined);
}

export function errorNotice(message: string) {
  new Notice("[ERROR] cortex: " + message, 0);
}
