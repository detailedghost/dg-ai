import boardHtml from "../../../pages/dist/board.html" with { type: "text" };
import boardJs from "../../../pages/dist/board.js" with { type: "text" };
import chatHtml from "../../../pages/dist/chat.html" with { type: "text" };
import chatJs from "../../../pages/dist/chat.js" with { type: "text" };
import secretHtml from "../../../pages/dist/secret.html" with { type: "text" };
import secretJs from "../../../pages/dist/secret.js" with { type: "text" };

export const PAGE_ASSETS: Record<string, string> = {
	"/chat": chatHtml,
	"/board": boardHtml,
	"/secret": secretHtml,
	"/chat.js": chatJs,
	"/board.js": boardJs,
	"/secret.js": secretJs,
};
