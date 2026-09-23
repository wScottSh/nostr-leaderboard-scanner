/*
 * stars.js -- human names for the (course, keyId) pair a cabinet signs.
 * Course numbers are the decomp's COURSE_* ids (sm64-nostr
 * levels/course_defines.h); keyId is the grabbed star's index (0-5 = the six
 * act stars, 6 = the 100-coin star). Star names from text/us/courses.h.
 */

export const FPS = 30; // gGlobalTimer ticks at 30 fps (ADR-0007)

export const COURSES = {
  0: { abbr: 'CASTLE', name: 'Castle Secret Stars' },
  1: { abbr: 'BOB', name: 'Bob-omb Battlefield' },
  2: { abbr: 'WF', name: "Whomp's Fortress" },
  3: { abbr: 'JRB', name: 'Jolly Roger Bay' },
  4: { abbr: 'CCM', name: 'Cool, Cool Mountain' },
  5: { abbr: 'BBH', name: "Big Boo's Haunt" },
  6: { abbr: 'HMC', name: 'Hazy Maze Cave' },
  7: { abbr: 'LLL', name: 'Lethal Lava Land' },
  8: { abbr: 'SSL', name: 'Shifting Sand Land' },
  9: { abbr: 'DDD', name: 'Dire, Dire Docks' },
  10: { abbr: 'SL', name: "Snowman's Land" },
  11: { abbr: 'WDW', name: 'Wet-Dry World' },
  12: { abbr: 'TTM', name: 'Tall, Tall Mountain' },
  13: { abbr: 'THI', name: 'Tiny-Huge Island' },
  14: { abbr: 'TTC', name: 'Tick Tock Clock' },
  15: { abbr: 'RR', name: 'Rainbow Ride' },
  16: { abbr: 'BITDW', name: 'Bowser in the Dark World' },
  17: { abbr: 'BITFS', name: 'Bowser in the Fire Sea' },
  18: { abbr: 'BITS', name: 'Bowser in the Sky' },
  19: { abbr: 'PSS', name: "The Princess's Secret Slide" },
  20: { abbr: 'COTMC', name: 'Cavern of the Metal Cap' },
  21: { abbr: 'TOTWC', name: 'Tower of the Wing Cap' },
  22: { abbr: 'VCUTM', name: 'Vanish Cap under the Moat' },
  23: { abbr: 'WMOTR', name: 'Wing Mario over the Rainbow' },
  24: { abbr: 'SA', name: 'The Secret Aquarium' },
  25: { abbr: 'END', name: 'The End' },
};

const ACT_STARS = {
  1: ['Big Bob-omb on the Summit', 'Footrace with Koopa the Quick', 'Shoot to the Island in the Sky', 'Find the 8 Red Coins', 'Mario Wings to the Sky', "Behind Chain Chomp's Gate"],
  2: ["Chip off Whomp's Block", 'To the Top of the Fortress', 'Shoot into the Wild Blue', 'Red Coins on the Floating Isle', 'Fall onto the Caged Island', 'Blast Away the Wall'],
  3: ['Plunder in the Sunken Ship', 'Can the Eel Come Out to Play?', 'Treasure of the Ocean Cave', 'Red Coins on the Ship Afloat', 'Blast to the Stone Pillar', 'Through the Jet Stream'],
  4: ["Slip Slidin' Away", "Li'l Penguin Lost", 'Big Penguin Race', 'Frosty Slide for 8 Red Coins', "Snowman's Lost His Head", 'Wall Kicks Will Work'],
  5: ['Go on a Ghost Hunt', "Ride Big Boo's Merry-Go-Round", 'Secret of the Haunted Books', 'Seek the 8 Red Coins', "Big Boo's Balcony", 'Eye to Eye in the Secret Room'],
  6: ['Swimming Beast in the Cavern', 'Elevate for 8 Red Coins', 'Metal-Head Mario Can Move!', 'Navigating the Toxic Maze', 'A-Maze-Ing Emergency Exit', 'Watch for Rolling Rocks'],
  7: ['Boil the Big Bully', 'Bully the Bullies', '8-Coin Puzzle with 15 Pieces', 'Red-Hot Log Rolling', 'Hot-Foot-It into the Volcano', 'Elevator Tour in the Volcano'],
  8: ['In the Talons of the Big Bird', 'Shining atop the Pyramid', 'Inside the Ancient Pyramid', 'Stand Tall on the Four Pillars', 'Free Flying for 8 Red Coins', 'Pyramid Puzzle'],
  9: ["Board Bowser's Sub", 'Chests in the Current', 'Pole-Jumping for Red Coins', 'Through the Jet Stream', "The Manta Ray's Reward", 'Collect the Caps...'],
  10: ["Snowman's Big Head", 'Chill with the Bully', 'In the Deep Freeze', 'Whirl from the Freezing Pond', "Shell Shreddin' for Red Coins", 'Into the Igloo'],
  11: ['Shocking Arrow Lifts!', "Top o' the Town", 'Secrets in the Shallows & Sky', 'Express Elevator--Hurry Up!', 'Go to Town for Red Coins', 'Quick Race Through Downtown!'],
  12: ['Scale the Mountain', 'Mystery of the Monkey Cage', "Scary 'Shrooms, Red Coins", 'Mysterious Mountainside', 'Breathtaking View from Bridge', 'Blast to the Lonely Mushroom'],
  13: ['Pluck the Piranha Flower', 'The Tip Top of the Huge Island', 'Rematch with Koopa the Quick', 'Five Itty Bitty Secrets', "Wiggler's Red Coins", 'Make Wiggler Squirm'],
  14: ['Roll into the Cage', 'The Pit and the Pendulums', 'Get a Hand', 'Stomp on the Thwomp', 'Timed Jumps on Moving Bars', 'Stop Time for Red Coins'],
  15: ['Cruiser Crossing the Rainbow', 'The Big House in the Sky', 'Coins Amassed in a Maze', "Swingin' in the Breeze", 'Tricky Triangles!', 'Somewhere over the Rainbow'],
};

const CASTLE_STARS = ['Toad Star 1', 'Toad Star 2', 'Toad Star 3', 'MIPS Star 1', 'MIPS Star 2'];

export function courseName(course) {
  return COURSES[course]?.name ?? `Course ${course}`;
}

export function starName(course, keyId) {
  if (course === 0) return CASTLE_STARS[keyId] ?? `Castle Star ${keyId + 1}`;
  if (ACT_STARS[course]) {
    if (keyId === 6) return '100 Coins';
    return ACT_STARS[course][keyId] ?? `Star ${keyId + 1}`;
  }
  if (course === 19) return keyId === 0 ? 'Reach the Bottom' : keyId === 1 ? 'Under 21 Seconds' : `Star ${keyId + 1}`;
  if (COURSES[course]) return keyId === 0 ? 'Red Coins' : `Star ${keyId + 1}`;
  return `Star ${keyId + 1}`;
}

/** Sort key so boards list stars in game order: main courses, bonus, then castle. */
export function starOrder(course, keyId) {
  return (course === 0 ? 100 : course) * 16 + keyId;
}

/**
 * formatFrames: in-course frames -> the in-game timer's own M'SS"cc shape.
 * 0 is the cabinet's "no in-course time" sentinel (format-v3 spec 3.5).
 */
export function formatFrames(frames) {
  if (!frames) return '—';
  const totalCs = Math.floor((frames * 100) / FPS);
  const cs = totalCs % 100;
  const totalS = Math.floor(totalCs / 100);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60);
  return `${m}'${String(s).padStart(2, '0')}"${String(cs).padStart(2, '0')}`;
}
