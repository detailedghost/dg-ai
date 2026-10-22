import type { CommandSpec, Loader } from "../core/spec";
import attach from "./attach/spec";
import check from "./check/spec";
import click from "./click/spec";
import close from "./close/spec";
import closeAll from "./close-all/spec";
import consoleCommand from "./console/spec";
import cookieClear from "./cookie-clear/spec";
import cookieDelete from "./cookie-delete/spec";
import cookieGet from "./cookie-get/spec";
import cookieList from "./cookie-list/spec";
import cookieSet from "./cookie-set/spec";
import dblclick from "./dblclick/spec";
import deleteData from "./delete-data/spec";
import dialogAccept from "./dialog-accept/spec";
import dialogDismiss from "./dialog-dismiss/spec";
import drag from "./drag/spec";
import evalSpec from "./eval/spec";
import fill from "./fill/spec";
import goBack from "./go-back/spec";
import goForward from "./go-forward/spec";
import goto from "./goto/spec";
import hover from "./hover/spec";
import keydown from "./keydown/spec";
import keyup from "./keyup/spec";
import killAll from "./kill-all/spec";
import list from "./list/spec";
import localstorageClear from "./localstorage-clear/spec";
import localstorageDelete from "./localstorage-delete/spec";
import localstorageGet from "./localstorage-get/spec";
import localstorageList from "./localstorage-list/spec";
import localstorageSet from "./localstorage-set/spec";
import mousedown from "./mousedown/spec";
import mousemove from "./mousemove/spec";
import mouseup from "./mouseup/spec";
import mousewheel from "./mousewheel/spec";
import network from "./network/spec";
import networkStateSet from "./network-state-set/spec";
import open from "./open/spec";
import pdf from "./pdf/spec";
import press from "./press/spec";
import reload from "./reload/spec";
import resize from "./resize/spec";
import route from "./route/spec";
import routeList from "./route-list/spec";
import screenshot from "./screenshot/spec";
import select from "./select/spec";
import sessionstorageClear from "./sessionstorage-clear/spec";
import sessionstorageDelete from "./sessionstorage-delete/spec";
import sessionstorageGet from "./sessionstorage-get/spec";
import sessionstorageList from "./sessionstorage-list/spec";
import sessionstorageSet from "./sessionstorage-set/spec";
import snapshot from "./snapshot/spec";
import state from "./state/spec";
import stateLoad from "./state-load/spec";
import stateSave from "./state-save/spec";
import tabClose from "./tab-close/spec";
import tabList from "./tab-list/spec";
import tabNew from "./tab-new/spec";
import tabSelect from "./tab-select/spec";
import tracingStart from "./tracing-start/spec";
import tracingStop from "./tracing-stop/spec";
import type from "./type/spec";
import uncheck from "./uncheck/spec";
import unroute from "./unroute/spec";
import upload from "./upload/spec";
import videoChapter from "./video-chapter/spec";
import videoStart from "./video-start/spec";
import videoStop from "./video-stop/spec";

export type CommandEntry = { spec: CommandSpec; load: Loader };

export const COMMANDS: readonly CommandEntry[] = [
	{ spec: open, load: () => import("./open/run") },
	{ spec: attach, load: () => import("./attach/run") },
	{ spec: close, load: () => import("./close/run") },
	{ spec: list, load: () => import("./list/run") },
	{ spec: closeAll, load: () => import("./close-all/run") },
	{ spec: killAll, load: () => import("./kill-all/run") },
	{ spec: goto, load: () => import("./goto/run") },
	{ spec: snapshot, load: () => import("./snapshot/run") },
	{ spec: click, load: () => import("./click/run") },
	{ spec: fill, load: () => import("./fill/run") },
	{ spec: type, load: () => import("./type/run") },
	{ spec: press, load: () => import("./press/run") },
	{ spec: evalSpec, load: () => import("./eval/run") },
	{ spec: screenshot, load: () => import("./screenshot/run") },
	{ spec: check, load: () => import("./check/run") },
	{ spec: consoleCommand, load: () => import("./console/run") },
	{ spec: cookieClear, load: () => import("./cookie-clear/run") },
	{ spec: cookieDelete, load: () => import("./cookie-delete/run") },
	{ spec: cookieGet, load: () => import("./cookie-get/run") },
	{ spec: cookieList, load: () => import("./cookie-list/run") },
	{ spec: cookieSet, load: () => import("./cookie-set/run") },
	{ spec: dblclick, load: () => import("./dblclick/run") },
	{ spec: deleteData, load: () => import("./delete-data/run") },
	{ spec: dialogAccept, load: () => import("./dialog-accept/run") },
	{ spec: dialogDismiss, load: () => import("./dialog-dismiss/run") },
	{ spec: drag, load: () => import("./drag/run") },
	{ spec: goBack, load: () => import("./go-back/run") },
	{ spec: goForward, load: () => import("./go-forward/run") },
	{ spec: hover, load: () => import("./hover/run") },
	{ spec: keydown, load: () => import("./keydown/run") },
	{ spec: keyup, load: () => import("./keyup/run") },
	{ spec: localstorageClear, load: () => import("./localstorage-clear/run") },
	{ spec: localstorageDelete, load: () => import("./localstorage-delete/run") },
	{ spec: localstorageGet, load: () => import("./localstorage-get/run") },
	{ spec: localstorageList, load: () => import("./localstorage-list/run") },
	{ spec: localstorageSet, load: () => import("./localstorage-set/run") },
	{ spec: mousedown, load: () => import("./mousedown/run") },
	{ spec: mousemove, load: () => import("./mousemove/run") },
	{ spec: mouseup, load: () => import("./mouseup/run") },
	{ spec: mousewheel, load: () => import("./mousewheel/run") },
	{ spec: network, load: () => import("./network/run") },
	{ spec: networkStateSet, load: () => import("./network-state-set/run") },
	{ spec: pdf, load: () => import("./pdf/run") },
	{ spec: reload, load: () => import("./reload/run") },
	{ spec: resize, load: () => import("./resize/run") },
	{ spec: route, load: () => import("./route/run") },
	{ spec: routeList, load: () => import("./route-list/run") },
	{ spec: select, load: () => import("./select/run") },
	{ spec: sessionstorageClear, load: () => import("./sessionstorage-clear/run") },
	{ spec: sessionstorageDelete, load: () => import("./sessionstorage-delete/run") },
	{ spec: sessionstorageGet, load: () => import("./sessionstorage-get/run") },
	{ spec: sessionstorageList, load: () => import("./sessionstorage-list/run") },
	{ spec: sessionstorageSet, load: () => import("./sessionstorage-set/run") },
	{ spec: state, load: () => import("./state/run") },
	{ spec: stateLoad, load: () => import("./state-load/run") },
	{ spec: stateSave, load: () => import("./state-save/run") },
	{ spec: tabClose, load: () => import("./tab-close/run") },
	{ spec: tabList, load: () => import("./tab-list/run") },
	{ spec: tabNew, load: () => import("./tab-new/run") },
	{ spec: tabSelect, load: () => import("./tab-select/run") },
	{ spec: tracingStart, load: () => import("./tracing-start/run") },
	{ spec: tracingStop, load: () => import("./tracing-stop/run") },
	{ spec: uncheck, load: () => import("./uncheck/run") },
	{ spec: unroute, load: () => import("./unroute/run") },
	{ spec: upload, load: () => import("./upload/run") },
	{ spec: videoChapter, load: () => import("./video-chapter/run") },
	{ spec: videoStart, load: () => import("./video-start/run") },
	{ spec: videoStop, load: () => import("./video-stop/run") },
];
