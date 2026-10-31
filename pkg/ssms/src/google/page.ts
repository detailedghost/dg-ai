export const MESSAGES_URL = "https://messages.google.com/web/u/0/conversations";

export const PAGE_ACTIONS = [
	"status",
	"list",
	"read",
	"archive",
	"block",
	"send",
	"delete",
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
    var el = labeled(name);
    if (!el || typeof el.click !== "function") return false;
    el.click();
    clicks.push(name);
    return true;
  }
  function rowFrom(el) {
    var id = attr(el, "data-conversation-id") || attr(el, "href") || "";
    var parts = String(id).split("/").filter(Boolean);
    return {
      id: parts.length ? parts[parts.length - 1] : String(id),
      sender: attr(el, "data-sender") || textOf(el).slice(0, 80),
      preview: attr(el, "data-preview") || "",
      pinned: attr(el, "data-pinned") === "true",
      savedContact: attr(el, "data-saved") === "true",
      ageDays: Number(attr(el, "data-age-days") || "0")
    };
  }
  function conversationRows() {
    var marked = nodes().filter(function (el) {
      return attr(el, "data-conversation-id") && !attr(el, "data-message-id");
    });
    if (marked.length) return marked.map(rowFrom);
    var links = nodes().filter(function (el) {
      var href = attr(el, "href");
      return typeof href === "string" && href.indexOf("/conversations/") !== -1;
    });
    return links.map(rowFrom);
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
  if (action === "read") {
    var wanted = String(args.conversationId || "");
    var limit = Number(args.limit);
    if (!Number.isFinite(limit) || limit < 0) limit = 0;
    var messages = nodes().filter(function (el) {
      return attr(el, "data-message-id") && (!wanted || attr(el, "data-conversation-id") === wanted);
    }).map(function (el) {
      return {
        id: attr(el, "data-message-id"),
        conversationId: attr(el, "data-conversation-id") || wanted,
        timestamp: Number(attr(el, "data-timestamp") || "0"),
        senderId: attr(el, "data-sender-id") || "",
        text: attr(el, "data-text") || textOf(el),
        contentType: attr(el, "data-content-type") || ""
      };
    });
    messages.sort(function (a, b) { return b.timestamp - a.timestamp; });
    return { messages: messages.slice(0, limit), clicks: clicks };
  }
  if (action === "archive" || action === "block") {
    var id = String(args.conversationId || "");
    var row = nodes().find(function (el) { return attr(el, "data-conversation-id") === id; });
    if (!row) throw new Error("conversation not found");
    if (typeof row.click === "function") row.click();
    clicks.push("open:" + id);
    if (action === "archive") {
      clickLabel("Options");
      if (!labeled("Archive")) throw new Error("archive control missing");
      clickLabel("Archive");
      if (clicks.indexOf("Delete") !== -1) throw new Error("delete is disabled");
      return { conversationId: id, reason: "archived", clicks: clicks };
    }
    clickLabel("Details");
    if (!labeled("Block & report spam")) throw new Error("spam control missing");
    clickLabel("Block & report spam");
    if (clicks.indexOf("Delete") !== -1) throw new Error("delete is disabled");
    return { conversationId: id, reason: "blocked", clicks: clicks };
  }
  if (action === "send") {
    if (args.confirmed !== true) throw new Error("send requires confirmation");
    var box = nodes().find(function (el) { return attr(el, "data-compose") === "true"; });
    if (!box) throw new Error("compose box missing");
    box.textContent = String(args.text || "");
    if (!clickLabel("Send")) throw new Error("send control missing");
    return { draftId: String(args.draftId || ""), reason: "sent", clicks: clicks };
  }
  throw new Error("unknown page action");
}`;
}

export function evaluateMessagesAction(
	document: unknown,
	action: PageAction,
	args: Record<string, unknown>,
): unknown {
	const fn = new Function(
		"document",
		"action",
		"args",
		`${messagesPageSource()}\nreturn runMessagesAction(document, action, args);`,
	);
	return fn(document, action, args);
}
