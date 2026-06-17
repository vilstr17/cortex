import { Notice } from "obsidian";

export function chronoteNotice(message: string, duration?: number) {
  new Notice("chronote: " + message, duration ? duration : undefined);
}

export function errorNotice(message: string) {
  new Notice("[ERROR] chronote: " + message, 0);
}
