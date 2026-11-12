# Unsupported methods

Discovery methods that are not generated, with the reason. Produced by scripts/gen-sdk.ts. Do not edit.

Only these methods are considered for the apis below. Every other method of those documents is omitted by the allowlist and counted in no total.

- admin: `directory.groups.*`, `directory.members.*`
- googleads: `googleads.customers.listAccessibleCustomers`, `googleads.customers.googleAds.search`, `googleads.customers.googleAds.searchStream`, `*.mutate`

| method | reason |
|---|---|
| analyticsadmin.accounts.searchChangeHistoryEvents | parameter name account collides with a reserved input key |
| calendar.acl.watch | push notification channel; needs a public receiver |
| calendar.calendarList.watch | push notification channel; needs a public receiver |
| calendar.channels.stop | push notification channel; needs a public receiver |
| calendar.events.watch | push notification channel; needs a public receiver |
| calendar.settings.watch | push notification channel; needs a public receiver |
| drive.changes.watch | push notification channel; needs a public receiver |
| drive.channels.stop | push notification channel; needs a public receiver |
| drive.files.watch | push notification channel; needs a public receiver |
| forms.forms.watches.create | push notification channel; needs a public receiver |
| forms.forms.watches.delete | push notification channel; needs a public receiver |
| forms.forms.watches.list | push notification channel; needs a public receiver |
| forms.forms.watches.renew | push notification channel; needs a public receiver |
| gmail.users.stop | push notification channel; needs a public receiver |
| gmail.users.watch | push notification channel; needs a public receiver |

## Totals

- gmail: 77 supported, 2 unsupported, 79 total
- drive: 61 supported, 3 unsupported, 64 total
- calendar: 33 supported, 5 unsupported, 38 total
- sheets: 17 supported, 0 unsupported, 17 total
- docs: 3 supported, 0 unsupported, 3 total
- forms: 6 supported, 4 unsupported, 10 total
- tasks: 14 supported, 0 unsupported, 14 total
- slides: 5 supported, 0 unsupported, 5 total
- searchconsole: 11 supported, 0 unsupported, 11 total
- analyticsdata: 11 supported, 0 unsupported, 11 total
- analyticsadmin: 54 supported, 1 unsupported, 55 total
- admin: 16 supported, 0 unsupported, 16 total
- groupssettings: 3 supported, 0 unsupported, 3 total
- tagmanager: 106 supported, 0 unsupported, 106 total
- googleads: 81 supported, 0 unsupported, 81 total
- all: 498 supported, 15 unsupported, 513 total
