export const reportTimezone = "America/Chicago";
export const localDate = (now:number,timezone:string) => new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
const DAY=86400000;
/** First instant in a local date. Binary search keeps 23/25-hour DST days exact. */
function midnight(date:string,timezone:string){
 const approximate=Date.parse(`${date}T00:00:00Z`);
 let low=approximate-36*3600000,high=approximate+36*3600000;
 while(low<high){const middle=Math.floor((low+high)/2);if(localDate(middle,timezone)<date)low=middle+1;else high=middle;}
 return low;
}
export function reportPeriodForDate(date:string,timezone=reportTimezone){
 const next=new Date(Date.parse(`${date}T00:00:00Z`)+DAY).toISOString().slice(0,10);
 return {date,timezone,start:midnight(date,timezone),end:midnight(next,timezone)};
}
export function previousReportPeriod(now:number,timezone=reportTimezone){
 const today=localDate(now,timezone);
 const date=new Date(Date.parse(`${today}T00:00:00Z`)-DAY).toISOString().slice(0,10);
 return reportPeriodForDate(date,timezone);
}
export type ReportPeriod=ReturnType<typeof previousReportPeriod>;

/** Explicit recovery dates name completed local days; ordinary schedules retain their previous-day default. */
export function requestedReportPeriod(at:number,timezone=reportTimezone,date?:string){
 if(date && date>=localDate(at,timezone))throw new Response("Choose a completed local date for report recovery",{status:400});
 return date?reportPeriodForDate(date,timezone):previousReportPeriod(at,timezone);
}
