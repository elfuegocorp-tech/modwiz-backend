// How many Souls finishing a given course is worth.
//
// The number is set by an admin on the COURSE'S OWN WordPress edit screen (the
// "Modwiz App" meta box — see wordpress/modwiz-course-rewards.php in the app
// repo), not here and not in the app. That is deliberate: the reward is a
// property of the course, so it belongs next to the course, and changing it
// must not need a deploy of anything.
//
// This backend therefore has to ASK WordPress. It asks as the calling user,
// forwarding their credential, because the route is a normal logged-in
// modwiz/v1 route like every other one this repo talks to — there is no service
// account, and a reward amount is not a secret.
//
// Every failure path returns 0 rather than throwing. A course with no reward
// set, an unreachable site, a malformed value: all of them mean "no Souls for
// this", and none of them should be allowed to fail a course completion that
// has already been recorded.
const { WP_BASE_URL } = require('./wp-auth');

// A ceiling on what one course can pay, as a guard against a typo in the meta
// box rather than against an admin — 25 Souls is the intended order of
// magnitude (Rp 24.750 at the fixed rate), so a stray extra digit turning 30
// into 30000 is the realistic accident this stops.
const MAX_COURSE_SOULS = 500;

async function courseSoulsReward(courseId, authHeader) {
  try {
    const res = await fetch(`${WP_BASE_URL}/wp-json/modwiz/v1/course-reward?course_id=${courseId}`, {
      headers: authHeader ? { Authorization: authHeader } : {},
    });
    if (!res.ok) return 0;

    const data = await res.json();
    const souls = Math.floor(Number(data && data.souls));
    if (!Number.isFinite(souls) || souls <= 0) return 0;
    if (souls > MAX_COURSE_SOULS) {
      console.error(`course-rewards: course ${courseId} is set to ${souls} Souls, capping at ${MAX_COURSE_SOULS}`);
      return MAX_COURSE_SOULS;
    }
    return souls;
  } catch (err) {
    console.error('course-rewards: could not read course reward:', err);
    return 0;
  }
}

module.exports = { courseSoulsReward, MAX_COURSE_SOULS };
