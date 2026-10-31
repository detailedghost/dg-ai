import { sendOnDocument, type SendDocument } from "./thread";

export const MESSAGES_URL = "https://messages.google.com/web/u/0/conversations";

export const PAGE_ACTIONS = [
	"status",
	"list",
	"read",
	"archive",
	"block",
	"send",
	"delete",
	"rows",
	"load-more",
] as const;

export type PageAction = (typeof PAGE_ACTIONS)[number];

export function messagesPageSource(): string {
	return `function runMessagesAction(document, action, args) {
  function textOf(el) {
    return String((el && (el.innerText || el.textContent)) || "").replace(/\\s+/g, " ").trim();
  }
  function nodes() {
    return Array.from(document.querySelectorAll("*"));
  }
  function attr(el, name) {
    return el && typeof el.getAttribute === "function" ? el.getAttribute(name) : null;
  }
  function tag(el) {
    return String(el && el.tagName || "").toUpperCase();
  }
  function conversationIdFromHref(href) {
    var match = /\\/conversations\\/([^/?#]+)/.exec(String(href || ""));
    return match ? decodeURIComponent(match[1]) : "";
  }
  function isMessage(el) {
    return tag(el) === "MWS-MESSAGE-WRAPPER";
  }
  function isConversation(el) {
    if (!el || isMessage(el)) return false;
    return conversationIdFromHref(attr(el, "href")).length > 0;
  }
  function labeled(name) {
    var hits = nodes().filter(function (el) { return textOf(el) === name; });
    if (hits.length) return hits[hits.length - 1];
    var aria = nodes().filter(function (el) {
      return attr(el, "aria-label") === name || attr(el, "title") === name;
    });
    return aria.length ? aria[aria.length - 1] : null;
  }
  var clicks = [];
  function clickLabel(name) {
    if (/delete/i.test(name)) throw new Error("delete is disabled");
    var el = labeled(name);
    if (!el || typeof el.click !== "function") return false;
    el.click();
    clicks.push(name);
    return true;
  }
  function ageDaysOf(el) {
    var raw = attr(el, "datetime");
    if (!raw) return 0;
    var parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return 0;
    var now = Number(args && args.nowMs);
    if (!Number.isFinite(now)) now = Date.now();
    return Math.max(0, Math.floor((now - parsed) / 86400000));
  }
  function rowFrom(el) {
    var id = conversationIdFromHref(attr(el, "href"));
    return {
      id: id,
      sender: attr(el, "aria-label") || textOf(el).slice(0, 80),
      preview: textOf(el),
      pinned: attr(el, "aria-pressed") === "true",
      savedContact: false,
      ageDays: ageDaysOf(el)
    };
  }
  function conversationRows() {
    return nodes().filter(isConversation).map(rowFrom);
  }
  function findConversation(id) {
    return nodes().find(function (el) {
      return isConversation(el) && conversationIdFromHref(attr(el, "href")) === id;
    }) || null;
  }
  function openConversation(id) {
    var link = findConversation(id);
    if (!link) throw new Error("conversation not found");
    if (typeof link.click === "function") link.click();
    clicks.push("open:" + id);
    var open = typeof document.openConversationId === "string"
      ? document.openConversationId
      : conversationIdFromHref(attr(link, "href"));
    if (open !== id) throw new Error("open conversation does not match the draft");
    return link;
  }
  function isCompose(el) {
    var name = tag(el);
    if (name === "TEXTAREA" || name === "INPUT") return true;
    if (attr(el, "contenteditable") === "true" || el.isContentEditable === true) return true;
    var label = attr(el, "aria-label");
    return label === "Text message";
  }
  function writeCompose(box, text) {
    var name = tag(box);
    if (name === "TEXTAREA" || name === "INPUT") {
      var Ctor = name === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
      if (typeof Ctor !== "function") throw new Error("compose box missing");
      var desc = Object.getOwnPropertyDescriptor(Ctor.prototype, "value");
      if (!desc || typeof desc.set !== "function") throw new Error("compose box missing");
      desc.set.call(box, text);
      if (typeof box.dispatchEvent !== "function") throw new Error("compose box missing");
      box.dispatchEvent(typeof Event === "function" ? new Event("input", { bubbles: true }) : { type: "input" });
      return;
    }
    if (attr(box, "contenteditable") === "true" || box.isContentEditable === true) {
      if (typeof box.focus === "function") box.focus();
      var inserted = false;
      if (typeof document.execCommand === "function") inserted = document.execCommand("insertText", false, text) === true;
      if (!inserted) throw new Error("compose box missing");
      if (typeof box.dispatchEvent === "function") {
        box.dispatchEvent(typeof InputEvent === "function"
          ? new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
          : { type: "input" });
      }
      return;
    }
    throw new Error("compose box missing");
  }
  function disabled(el) {
    return !el || el.disabled === true || attr(el, "aria-disabled") === "true";
  }
  if (action === "delete") throw new Error("delete is disabled");
  if (action === "status") {
    var body = textOf(document.body || document);
    if (/Trying to reach your phone/i.test(body)) {
      return { state: "phone-unreachable", reason: "phone-banner", clicks: clicks };
    }
    var rows = conversationRows();
    if (/Sign in/i.test(body) && rows.length === 0) {
      return { state: "signed-out", reason: "sign-in", clicks: clicks };
    }
    if (rows.length > 0) {
      return { state: "paired", reason: "conversation-list", clicks: clicks, count: rows.length };
    }
    return { state: "unknown", reason: "page-unrecognized", clicks: clicks };
  }
  if (action === "list") {
    var scopeDays = args.scopeDays;
    var guard = 0;
    while (guard < 30 && labeled("Load more conversations")) {
      var current = conversationRows();
      if (typeof scopeDays === "number" && current.length > 0) {
        var oldest = current[current.length - 1].ageDays;
        if (oldest > scopeDays) break;
      }
      if (!clickLabel("Load more conversations")) break;
      guard += 1;
    }
    var listed = conversationRows();
    if (typeof scopeDays === "number") {
      listed = listed.filter(function (row) { return row.ageDays <= scopeDays; });
    }
    return { conversations: listed, clicks: clicks };
  }
  if (action === "rows") {
    return {
      conversations: conversationRows(),
      more: !!labeled("Load more conversations"),
      clicks: clicks
    };
  }
  if (action === "load-more") {
    var clicked = clickLabel("Load more conversations");
    return { clicked: clicked, conversations: conversationRows(), more: !!labeled("Load more conversations"), clicks: clicks };
  }
  if (action === "read") {
    var wanted = String(args.conversationId || "");
    var limit = Number(args.limit);
    if (!Number.isFinite(limit) || limit < 0) limit = 0;
    if (wanted) openConversation(wanted);
    var messages = nodes().filter(isMessage).map(function (el) {
      var raw = attr(el, "datetime") || "0";
      var timestamp = /^\\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      return {
        id: attr(el, "id") || "",
        conversationId: wanted,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        senderId: attr(el, "aria-label") || "",
        text: textOf(el),
        contentType: attr(el, "type") || ""
      };
    });
    messages.sort(function (a, b) { return b.timestamp - a.timestamp; });
    return { messages: messages.slice(0, limit), clicks: clicks };
  }
  if (action === "archive" || action === "block") {
    var id = String(args.conversationId || "");
    openConversation(id);
    if (action === "archive") {
      if (!labeled("Options")) throw new Error("archive control missing");
      clickLabel("Options");
      if (!labeled("Archive")) throw new Error("archive control missing");
      clickLabel("Archive");
      return { conversationId: id, reason: "archived", clicks: clicks };
    }
    if (!labeled("Details")) throw new Error("spam control missing");
    clickLabel("Details");
    if (!labeled("Block & report spam")) throw new Error("spam control missing");
    clickLabel("Block & report spam");
    return { conversationId: id, reason: "blocked", clicks: clicks };
  }
  if (action === "send") throw new Error("send is handled outside the page script");
  throw new Error("unknown page action");
}`;
}

export function evaluateMessagesAction(
	document: unknown,
	action: PageAction,
	args: Record<string, unknown>,
): unknown {
	if (action === "send") return sendOnDocument(document as SendDocument, args);
	const fn = new Function(
		"document",
		"action",
		"args",
		`${messagesPageSource()}\nreturn runMessagesAction(document, action, args);`,
	);
	return fn(document, action, args);
}
