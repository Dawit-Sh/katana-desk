//! The Journal (milestone 7): the whole year of reading days, totals, the books read in a week, month
//! or year, and the charts (days of the week, hours of the day, hours each month, pages an hour).
//! Everything is counted from the reader's own 15-second ticks: `reading_days` (every day since
//! milestone 1) and `reading_log` (per hour and book, with the pages turned, since milestone 7).

use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JBook {
    pub book_id: i64,
    pub title: String,
    pub author: Option<String>,
    pub format: String,
    pub cover: Option<String>,
    pub grimmory_id: Option<i64>,
    pub fraction: Option<f64>,
    pub finished_at: Option<i64>,
    pub seconds: i64,
    pub days: i64,
    pub pages: i64,
    pub highlights: i64,
    pub bookmarks: i64,
    pub last_day: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub today: String,
    pub year: i32,
    /// every reading day of the last 400 days (seconds), oldest first
    pub days: Vec<(String, i64)>,
    pub period: String,
    pub from: String,
    pub period_seconds: i64,
    pub week_seconds: i64,
    pub year_seconds: i64,
    pub finished_year: i64,
    pub finished_period: i64,
    pub books: Vec<JBook>,
    /// Monday..Sunday: seconds read in the period, and how many of that weekday the period has had so far
    pub weekdays: Vec<i64>,
    pub weekday_count: Vec<i64>,
    /// 0..23: seconds read in each hour of the day, in the period (from the hourly log)
    pub hours: Vec<i64>,
    /// January..December of this year: seconds
    pub months: Vec<i64>,
    /// the last 16 weeks, oldest first: (Monday, pages turned, seconds read) from the hourly log
    pub speed: Vec<(String, i64, i64)>,
    pub best_day: Option<(String, i64)>,
    /// seconds that count before the hourly log began (reading days without a book), in the period
    pub unlogged_seconds: i64,
}

fn d(s: &NaiveDate) -> String {
    s.format("%Y-%m-%d").to_string()
}

pub fn period_start(today: NaiveDate, period: &str) -> NaiveDate {
    match period {
        "week" => today - Duration::days(today.weekday().num_days_from_monday() as i64),
        "month" => today.with_day(1).unwrap_or(today),
        _ => NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today),
    }
}

fn sum_days(conn: &Connection, from: &str, to: &str) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COALESCE(SUM(seconds), 0) FROM reading_days WHERE day >= ?1 AND day <= ?2", params![from, to], |r| r.get(0))
}

fn ms_of(day: NaiveDate) -> i64 {
    use chrono::TimeZone;
    chrono::Local
        .from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}

/// `period` is "week", "month", "year" or a single day as "day:YYYY-MM-DD" (a reading day clicked in the
/// sidebar or the year map): the books, weekdays and hours are then that day's; the totals stay as they are.
pub fn stats(conn: &Connection, today: NaiveDate, period: &str) -> rusqlite::Result<Journal> {
    let one_day = period
        .strip_prefix("day:")
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .filter(|x| *x <= today);
    let period = match period {
        "week" | "month" | "year" => period,
        _ if one_day.is_some() => "day",
        _ => "year",
    };
    let t = d(&today);
    let from_date = one_day.unwrap_or_else(|| period_start(today, period));
    let to_date = one_day.unwrap_or(today);
    let from = d(&from_date);
    let to = d(&to_date);
    let year_start = NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap();
    let ys = d(&year_start);
    let since = d(&(today - Duration::days(400)));

    let mut st = conn.prepare("SELECT day, seconds FROM reading_days WHERE day >= ?1 AND seconds > 0 ORDER BY day")?;
    let days: Vec<(String, i64)> = st.query_map([&since], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;

    let period_seconds = sum_days(conn, &from, &to)?;
    let week_seconds = sum_days(conn, &d(&period_start(today, "week")), &t)?;
    let year_seconds = sum_days(conn, &ys, &t)?;

    let to_ms = ms_of(to_date + Duration::days(1));
    let finished = |from: NaiveDate| -> rusqlite::Result<i64> {
        conn.query_row("SELECT COUNT(*) FROM books WHERE finished_at >= ?1 AND finished_at < ?2", [ms_of(from), to_ms], |r| r.get(0))
    };
    let finished_year = finished(year_start)?;
    let finished_period = finished(from_date)?;

    // the books read in the period, most time first
    let from_ms = ms_of(from_date);
    let mut st = conn.prepare(
        "SELECT l.book_id, b.title, b.author, b.format, b.cover, b.grimmory_id, b.fraction, b.finished_at,
                SUM(l.seconds), COUNT(DISTINCT l.day), SUM(l.pages), MAX(l.day),
                (SELECT COUNT(*) FROM highlights h WHERE h.book_id = l.book_id AND h.deleted_at IS NULL AND h.created_at >= ?2 AND h.created_at < ?4),
                (SELECT COUNT(*) FROM bookmarks m WHERE m.book_id = l.book_id AND m.deleted_at IS NULL AND m.created_at >= ?2 AND m.created_at < ?4)
         FROM reading_log l JOIN books b ON b.id = l.book_id
         WHERE l.day >= ?1 AND l.day <= ?3
         GROUP BY l.book_id
         ORDER BY SUM(l.seconds) DESC",
    )?;
    let books = st
        .query_map(params![from, from_ms, to, to_ms], |r| {
            Ok(JBook {
                book_id: r.get(0)?,
                title: r.get(1)?,
                author: r.get(2)?,
                format: r.get(3)?,
                cover: r.get(4)?,
                grimmory_id: r.get(5)?,
                fraction: r.get(6)?,
                finished_at: r.get(7)?,
                seconds: r.get(8)?,
                days: r.get(9)?,
                pages: r.get(10)?,
                last_day: r.get(11)?,
                highlights: r.get(12)?,
                bookmarks: r.get(13)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let logged: i64 = books.iter().map(|b| b.seconds).sum();

    // days of the week in the period (reading_days counts every day, the hourly log or not)
    let mut weekdays = vec![0i64; 7];
    let mut weekday_count = vec![0i64; 7];
    for (day, secs) in &days {
        if day.as_str() >= from.as_str() && day.as_str() <= to.as_str() {
            if let Ok(x) = NaiveDate::parse_from_str(day, "%Y-%m-%d") {
                weekdays[x.weekday().num_days_from_monday() as usize] += secs;
            }
        }
    }
    let mut x = from_date;
    while x <= to_date {
        weekday_count[x.weekday().num_days_from_monday() as usize] += 1;
        x += Duration::days(1);
    }

    let mut hours = vec![0i64; 24];
    let mut st = conn.prepare("SELECT hour, SUM(seconds) FROM reading_log WHERE day >= ?1 AND day <= ?2 GROUP BY hour")?;
    for row in st.query_map([&from, &to], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
        let (h, s) = row?;
        if (0..24).contains(&h) {
            hours[h as usize] += s;
        }
    }

    let mut months = vec![0i64; 12];
    for (day, secs) in &days {
        if day.as_str() >= ys.as_str() {
            if let Ok(x) = NaiveDate::parse_from_str(day, "%Y-%m-%d") {
                months[x.month0() as usize] += secs;
            }
        }
    }

    // pages an hour, week by week (the last 16 weeks)
    let monday = period_start(today, "week");
    let first = monday - Duration::weeks(15);
    let mut speed: Vec<(String, i64, i64)> = (0..16).map(|i| (d(&(first + Duration::weeks(i))), 0, 0)).collect();
    let mut st = conn.prepare("SELECT day, SUM(pages), SUM(seconds) FROM reading_log WHERE day >= ?1 GROUP BY day")?;
    for row in st.query_map([d(&first)], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))? {
        let (day, p, s) = row?;
        if let Ok(x) = NaiveDate::parse_from_str(&day, "%Y-%m-%d") {
            let w = (x - first).num_days() / 7;
            if (0..16).contains(&w) {
                speed[w as usize].1 += p;
                speed[w as usize].2 += s;
            }
        }
    }

    let best_day = days.iter().filter(|(day, _)| day.as_str() >= ys.as_str()).max_by_key(|(_, s)| *s).cloned();

    Ok(Journal {
        today: t,
        year: today.year(),
        days,
        period: period.to_string(),
        from,
        period_seconds,
        week_seconds,
        year_seconds,
        finished_year,
        finished_period,
        books,
        weekdays,
        weekday_count,
        hours,
        months,
        speed,
        best_day,
        unlogged_seconds: (period_seconds - logged).max(0),
    })
}

/// The Journal as Markdown: the year's totals, the months, and every book read this year.
pub fn markdown(j: &Journal, today_long: &str) -> String {
    let hm = |s: i64| {
        let m = (s + 30) / 60;
        if m >= 60 {
            format!("{} h {} min", m / 60, m % 60)
        } else {
            format!("{m} min")
        }
    };
    let mut out = format!("# Reading journal {}\n\nExported from Katana Desk on {today_long}.\n\n", j.year);
    let read_days = j.days.iter().filter(|(day, _)| day.starts_with(&j.year.to_string())).count();
    out.push_str(&format!(
        "- Read on {read_days} days, {} in all\n- Books finished: {}\n",
        hm(j.year_seconds),
        j.finished_year
    ));
    if let Some((day, s)) = &j.best_day {
        out.push_str(&format!("- Best day: {day}, {}\n", hm(*s)));
    }
    out.push_str("\n## Months\n\n");
    const M: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    for (i, s) in j.months.iter().enumerate() {
        if *s > 0 {
            out.push_str(&format!("- {}: {}\n", M[i], hm(*s)));
        }
    }
    out.push_str("\n## Books\n\n");
    for b in &j.books {
        let by = b.author.as_deref().map(|a| format!(" by {a}")).unwrap_or_default();
        let done = if b.finished_at.is_some() { ", finished" } else { "" };
        out.push_str(&format!("- **{}**{by}: {} over {} days{done}\n", b.title, hm(b.seconds), b.days));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn periods_start_on_monday_first_and_new_year() {
        let t = NaiveDate::from_ymd_opt(2026, 11, 20).unwrap(); // a Friday
        assert_eq!(d(&period_start(t, "week")), "2026-11-16");
        assert_eq!(d(&period_start(t, "month")), "2026-11-01");
        assert_eq!(d(&period_start(t, "year")), "2026-01-01");
    }

    #[test]
    fn counts_from_the_log() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author TEXT, format TEXT, cover TEXT, grimmory_id INTEGER, fraction REAL, finished_at INTEGER);
             CREATE TABLE reading_days (day TEXT PRIMARY KEY, seconds INTEGER);
             CREATE TABLE highlights (book_id INTEGER, deleted_at INTEGER, created_at INTEGER);
             CREATE TABLE bookmarks (book_id INTEGER, deleted_at INTEGER, created_at INTEGER);",
        )
        .unwrap();
        c.execute_batch(crate::db::SCHEMA_V7_LOG).unwrap();
        c.execute("INSERT INTO books VALUES (1, 'A', NULL, 'epub', NULL, NULL, 0.5, NULL)", []).unwrap();
        for (day, h, s, p) in [("2026-11-18", 21, 600, 12), ("2026-11-19", 7, 300, 4), ("2026-10-02", 21, 60, 1)] {
            crate::db::add_reading(&c, day, h, Some(1), s, p).unwrap();
        }
        let t = NaiveDate::from_ymd_opt(2026, 11, 20).unwrap();
        let j = stats(&c, t, "month").unwrap();
        assert_eq!(j.period_seconds, 900);
        assert_eq!(j.year_seconds, 960);
        assert_eq!(j.books.len(), 1);
        assert_eq!((j.books[0].seconds, j.books[0].days, j.books[0].pages), (900, 2, 16));
        assert_eq!(j.hours[21], 600);
        assert_eq!(j.weekdays[2], 600); // the 18th was a Wednesday
        assert_eq!(j.months[9], 60);
        assert_eq!(j.speed.last().unwrap().1, 16);
        assert_eq!(j.best_day.as_ref().unwrap().0, "2026-11-18");
        // one day: that day's book, weekday and hours; the totals stay
        let one = stats(&c, t, "day:2026-11-19").unwrap();
        assert_eq!((one.period.as_str(), one.from.as_str(), one.period_seconds), ("day", "2026-11-19", 300));
        assert_eq!((one.books[0].seconds, one.books[0].pages), (300, 4));
        assert_eq!((one.hours[7], one.hours[21]), (300, 0));
        assert_eq!(one.weekday_count.iter().sum::<i64>(), 1);
        assert_eq!(one.year_seconds, 960);
        // a day to come, or no date, is the year
        assert_eq!(stats(&c, t, "day:2026-12-01").unwrap().period, "year");
    }
}
