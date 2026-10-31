export interface SmsCleanupConfig {
	allow_delete: boolean;
	allow_send: boolean;
	flag_ambiguous: boolean;
	dry_run: boolean;
	scope: "all" | `last_${number}_days`;
	keep: {
		pinned: boolean;
		personal_and_family: boolean;
		health: boolean;
		user_keep_list: string[];
	};
	groups: {
		dev: string[];
		personal_notifications: string[];
	};
	archive: {
		business_promos: boolean;
		completed_delivery_notices: boolean;
		expired_codes_older_than_days: number;
		past_nonmedical_reminders: boolean;
		user_archive_list: string[];
	};
	block_and_report_spam: {
		political_campaign_poll_fundraising: boolean;
		obvious_scams: boolean;
		user_spam_list: string[];
	};
	never_misclassify_as_spam: string[];
}

export function defaultCleanupConfig(): SmsCleanupConfig {
	return {
		allow_delete: false,
		allow_send: false,
		flag_ambiguous: true,
		dry_run: false,
		scope: "all",
		keep: {
			pinned: true,
			personal_and_family: true,
			health: true,
			user_keep_list: [],
		},
		groups: {
			dev: [],
			personal_notifications: [],
		},
		archive: {
			business_promos: true,
			completed_delivery_notices: true,
			expired_codes_older_than_days: 3,
			past_nonmedical_reminders: true,
			user_archive_list: [],
		},
		block_and_report_spam: {
			political_campaign_poll_fundraising: true,
			obvious_scams: true,
			user_spam_list: [],
		},
		never_misclassify_as_spam: [],
	};
}
