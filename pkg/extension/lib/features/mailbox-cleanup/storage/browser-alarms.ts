import type { BindingAlarmSeam } from "./raw-bindings";

const ALARM_PREFIX = "dg:mailbox:raw-binding-expiry:";
const RAW_BINDING_PREFIX = "dg:mailbox:raw-bindings:v1:";

type AlarmApi = Readonly<{
	create(name: string, info: Readonly<{ when: number }>): Promise<void> | void;
	clear(name: string): Promise<boolean> | boolean;
	onAlarm: Readonly<{
		addListener(listener: (alarm: Readonly<{ name: string }>) => void): void;
		removeListener(listener: (alarm: Readonly<{ name: string }>) => void): void;
	}>;
}>;

type SessionArea = Readonly<{
	remove(key: string): Promise<void>;
}>;

/**
 * Browser alarms survive MV3 worker suspension and physically remove expired
 * session-only raw values. Read-time TTL checks remain the authority.
 */
export function createBrowserRawBindingAlarms(deps: Readonly<{
	alarms: AlarmApi;
	session: SessionArea;
}>): Readonly<{
	alarms: BindingAlarmSeam;
	dispose(): void;
}> {
	const listener = (alarm: Readonly<{ name: string }>): void => {
		if (!alarm.name.startsWith(ALARM_PREFIX)) return;
		const key = alarm.name.slice(ALARM_PREFIX.length);
		if (!key.startsWith(RAW_BINDING_PREFIX)) return;
		void deps.session.remove(key).catch(() => undefined);
	};
	deps.alarms.onAlarm.addListener(listener);
	return Object.freeze({
		alarms: Object.freeze({
			schedule(key: string, when: number) {
				if (!key.startsWith(RAW_BINDING_PREFIX)) {
					throw new Error("Invalid mailbox binding alarm");
				}
				return deps.alarms.create(`${ALARM_PREFIX}${key}`, { when });
			},
			async cancel(key: string) {
				if (!key.startsWith(RAW_BINDING_PREFIX)) return;
				await deps.alarms.clear(`${ALARM_PREFIX}${key}`);
			},
		}),
		dispose() {
			deps.alarms.onAlarm.removeListener(listener);
		},
	});
}
