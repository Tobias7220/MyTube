// Category picks: label -> YouTube category (as Piped/yt-dlp report it) + a search query used to fetch videos.
const INTERESTS = {
  'Gaming': { category: 'Gaming', query: 'gameplay' },
  'Music': { category: 'Music', query: 'music' },
  'Technology': { category: 'Science & Technology', query: 'tech review' },
  'Science': { category: 'Science & Technology', query: 'science explained' },
  'Education': { category: 'Education', query: 'tutorial lecture' },
  'Cooking': { category: 'Howto & Style', query: 'cooking recipe' },
  'DIY': { category: 'Howto & Style', query: 'diy how to build' },
  'Film & Animation': { category: 'Film & Animation', query: 'film analysis' },
  'Entertainment': { category: 'Entertainment', query: 'entertainment' },
  'Comedy': { category: 'Comedy', query: 'comedy sketch' },
  'Sports': { category: 'Sports', query: 'sports highlights' },
  'News': { category: 'News & Politics', query: 'news' },
  'Cars': { category: 'Autos & Vehicles', query: 'cars review' },
  'Travel': { category: 'Travel & Events', query: 'travel vlog' },
  'Animals': { category: 'Pets & Animals', query: 'animals' },
  'Vlogs': { category: 'People & Blogs', query: 'vlog' },
};
// Labels used by the earlier Norwegian prototype.
const LEGACY = { Musikk: 'Music', Teknologi: 'Technology', Vitenskap: 'Science', Utdanning: 'Education', Matlaging: 'Cooking',
  'Gjør-det-selv': 'DIY', 'Film og animasjon': 'Film & Animation', Underholdning: 'Entertainment', Komedie: 'Comedy',
  Sport: 'Sports', Nyheter: 'News', 'Bil og kjøretøy': 'Cars', Reise: 'Travel', Dyr: 'Animals', 'Folk og blogger': 'Vlogs' };
module.exports = { INTERESTS, LEGACY };
