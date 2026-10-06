export interface InterviewPrompt {
  title: string;
  brief: string;
}

export const INTERVIEW_PROMPTS: InterviewPrompt[] = [
  { title: 'Design a URL shortener', brief: '100M new links a month, reads far outnumber writes, links never expire.' },
  { title: 'Design a news feed', brief: 'Users follow others and see a ranked feed. 50M daily active users.' },
  { title: 'Design a chat app', brief: 'One-to-one and group messages, delivered in under a second, with history.' },
  { title: 'Design a ride-hailing backend', brief: 'Match riders to nearby drivers, track trips live, take payments.' },
  { title: 'Design a video streaming service', brief: 'Creators upload, viewers stream worldwide in several resolutions.' },
  { title: 'Design a notification system', brief: 'Send email, SMS and push for many products, with retries and limits.' },
  { title: 'Design a file storage service', brief: 'Upload, sync and share files across devices, like Dropbox.' },
  { title: 'Design an e-commerce checkout', brief: 'Cart, orders, payments and inventory during a flash sale.' },
  { title: 'Design a web crawler', brief: 'Crawl a billion pages a month politely and store them for search.' },
  { title: 'Design a leaderboard', brief: 'Live global ranking for a game with 10M players.' },
];

export const INTERVIEW_SECONDS = 10 * 60;

export function pickPrompt(exclude?: string): InterviewPrompt {
  const pool = INTERVIEW_PROMPTS.filter((p) => p.title !== exclude);
  return pool[Math.floor(Math.random() * pool.length)];
}

export function verdict(score: number): string {
  if (score >= 85) return 'Strong hire';
  if (score >= 70) return 'Hire';
  if (score >= 50) return 'Lean no hire';
  return 'No hire yet';
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
