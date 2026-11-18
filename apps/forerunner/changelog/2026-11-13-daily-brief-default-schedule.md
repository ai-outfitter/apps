# The daily brief schedule defaults on

`SetDailyBriefSchedule` takes `ifUnset`. With it, the standard 05:00 schedule is saved in the given time zone only when no daily brief schedule exists; a schedule that was turned off or customized is returned untouched. Forerunner's `POST /api/apps/forerunner/schedule`, which Settings and Sources send with the device time zone, now also asks for it, and the platform's Today page does the same.

Personal installations only. No connection is attached, no discovery schedule or permission changes, and nothing is created without a device time zone. See [daily brief](../docs/daily-brief.md).

Validation: unit tests for a fresh install, repeat calls, disabled and customized schedules, organizations, readers and invalid zones.
