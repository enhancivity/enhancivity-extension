(function initEnhancivitySiteRegistry(rootFactory) {
  const root = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof self !== 'undefined' ? self : this);
  const api = rootFactory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.EnhancivitySiteRegistry = api;
})(function buildEnhancivitySiteRegistry() {
  'use strict';

  const SITE_REGISTRY = [
    {
      id: 'amazon',
      label: 'Amazon',
      canonicalDomain: 'amazon.com',
      family: 'amazon',
      aliases: ['amazon'],
      domainVariants: ['amazon.com', 'amazon.de', 'amazon.co.uk', 'amazon.ca', 'amazon.com.au'],
      promptDestination: 'amazon.com',
    },
    {
      id: 'gmail',
      label: 'Gmail',
      canonicalDomain: 'mail.google.com',
      family: 'gmail',
      aliases: ['gmail', 'google mail'],
      domainVariants: ['mail.google.com'],
      promptDestination: 'https://mail.google.com/',
    },
    {
      id: 'google_calendar',
      label: 'Google Calendar',
      canonicalDomain: 'calendar.google.com',
      family: 'google',
      aliases: ['google calendar'],
      domainVariants: ['calendar.google.com'],
      promptDestination: 'https://calendar.google.com/',
    },
    {
      id: 'google_meet',
      label: 'Google Meet',
      canonicalDomain: 'meet.google.com',
      family: 'google',
      aliases: ['google meet', 'meet'],
      domainVariants: ['meet.google.com'],
      promptDestination: 'https://meet.google.com/',
    },
    {
      id: 'google_contacts',
      label: 'Google Contacts',
      canonicalDomain: 'contacts.google.com',
      family: 'google',
      aliases: ['google contacts'],
      domainVariants: ['contacts.google.com'],
      promptDestination: 'https://contacts.google.com/',
    },
    {
      id: 'google_drive',
      label: 'Google Drive',
      canonicalDomain: 'drive.google.com',
      family: 'google',
      aliases: ['google drive'],
      domainVariants: ['drive.google.com'],
      promptDestination: 'https://drive.google.com/',
    },
    {
      id: 'google_sheets',
      label: 'Google Sheets',
      canonicalDomain: 'docs.google.com',
      family: 'google',
      aliases: ['google sheets'],
      domainVariants: ['docs.google.com'],
      promptDestination: 'https://docs.google.com/spreadsheets/u/0/',
    },
    {
      id: 'google_docs',
      label: 'Google Docs',
      canonicalDomain: 'docs.google.com',
      family: 'google',
      aliases: ['google docs'],
      domainVariants: ['docs.google.com'],
      promptDestination: 'https://docs.google.com/document/u/0/',
    },
    {
      id: 'google_slides',
      label: 'Google Slides',
      canonicalDomain: 'docs.google.com',
      family: 'google',
      aliases: ['google slides'],
      domainVariants: ['docs.google.com'],
      promptDestination: 'https://docs.google.com/presentation/u/0/',
    },
    {
      id: 'facebook',
      label: 'Facebook',
      canonicalDomain: 'facebook.com',
      family: 'facebook',
      aliases: ['facebook'],
      domainVariants: ['facebook.com'],
      promptDestination: 'facebook.com',
    },
    {
      id: 'youtube',
      label: 'YouTube',
      canonicalDomain: 'youtube.com',
      family: 'youtube',
      aliases: ['youtube'],
      domainVariants: ['youtube.com'],
      promptDestination: 'youtube.com',
    },
    {
      id: 'x',
      label: 'Twitter/X',
      canonicalDomain: 'x.com',
      family: 'x',
      aliases: ['twitter', 'x.com'],
      domainVariants: ['x.com'],
      promptDestination: 'x.com',
    },
    {
      id: 'linkedin',
      label: 'LinkedIn',
      canonicalDomain: 'linkedin.com',
      family: 'linkedin',
      aliases: ['linkedin'],
      domainVariants: ['linkedin.com'],
      promptDestination: 'linkedin.com',
    },
    {
      id: 'instagram',
      label: 'Instagram',
      canonicalDomain: 'instagram.com',
      family: 'instagram',
      aliases: ['instagram'],
      domainVariants: ['instagram.com'],
      promptDestination: 'instagram.com',
    },
    {
      id: 'notion',
      label: 'Notion',
      canonicalDomain: 'notion.so',
      family: 'notion',
      aliases: ['notion'],
      domainVariants: ['notion.so'],
      promptDestination: 'notion.so',
    },
    {
      id: 'github',
      label: 'GitHub',
      canonicalDomain: 'github.com',
      family: 'github',
      aliases: ['github'],
      domainVariants: ['github.com'],
      promptDestination: 'github.com',
    },
    {
      id: 'reddit',
      label: 'Reddit',
      canonicalDomain: 'reddit.com',
      family: 'reddit',
      aliases: ['reddit'],
      domainVariants: ['reddit.com'],
      promptDestination: 'reddit.com',
    },
    {
      id: 'ebay',
      label: 'eBay',
      canonicalDomain: 'ebay.com',
      family: 'ebay',
      aliases: ['ebay'],
      domainVariants: ['ebay.com', 'ebay.de', 'ebay.co.uk', 'ebay.ca'],
      promptDestination: 'ebay.com',
    },
    {
      id: 'netflix',
      label: 'Netflix',
      canonicalDomain: 'netflix.com',
      family: 'netflix',
      aliases: ['netflix'],
      domainVariants: ['netflix.com'],
      promptDestination: 'netflix.com',
    },
    {
      id: 'spotify',
      label: 'Spotify',
      canonicalDomain: 'open.spotify.com',
      family: 'spotify',
      aliases: ['spotify'],
      domainVariants: ['open.spotify.com', 'spotify.com'],
      promptDestination: 'open.spotify.com',
    },
    {
      id: 'excel_online',
      label: 'Excel Online',
      canonicalDomain: 'excel.cloud.microsoft.com',
      family: 'microsoft',
      aliases: ['excel online'],
      domainVariants: ['excel.cloud.microsoft.com'],
      promptDestination: 'https://excel.cloud.microsoft.com/',
    },
    {
      id: 'word_online',
      label: 'Word Online',
      canonicalDomain: 'word.new',
      family: 'microsoft',
      aliases: ['word online'],
      domainVariants: ['word.new'],
      promptDestination: 'word.new',
    },
    {
      id: 'powerpoint_online',
      label: 'PowerPoint Online',
      canonicalDomain: 'powerpoint.new',
      family: 'microsoft',
      aliases: ['powerpoint online'],
      domainVariants: ['powerpoint.new'],
      promptDestination: 'powerpoint.new',
    },
    {
      id: 'whatsapp',
      label: 'WhatsApp Web',
      canonicalDomain: 'web.whatsapp.com',
      family: 'whatsapp',
      aliases: ['whatsapp web'],
      domainVariants: ['web.whatsapp.com'],
      promptDestination: 'web.whatsapp.com',
    },
    {
      id: 'telegram',
      label: 'Telegram Web',
      canonicalDomain: 'web.telegram.org',
      family: 'telegram',
      aliases: ['telegram web'],
      domainVariants: ['web.telegram.org'],
      promptDestination: 'web.telegram.org',
    },
    {
      id: 'outlook',
      label: 'Outlook',
      canonicalDomain: 'outlook.live.com',
      family: 'outlook',
      aliases: ['outlook', 'hotmail'],
      domainVariants: ['outlook.live.com'],
      promptDestination: 'https://outlook.live.com/',
    },
    {
      id: 'yahoo_mail',
      label: 'Yahoo Mail',
      canonicalDomain: 'mail.yahoo.com',
      family: 'yahoo',
      aliases: ['yahoo mail'],
      domainVariants: ['mail.yahoo.com'],
    },
    {
      id: 'zoom',
      label: 'Zoom',
      canonicalDomain: 'zoom.us',
      family: 'zoom',
      aliases: ['zoom'],
      domainVariants: ['zoom.us'],
      promptDestination: 'zoom.us',
    },
    {
      id: 'trello',
      label: 'Trello',
      canonicalDomain: 'trello.com',
      family: 'trello',
      aliases: ['trello'],
      domainVariants: ['trello.com'],
      promptDestination: 'trello.com',
    },
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      canonicalDomain: 'chatgpt.com',
      family: 'chatgpt',
      aliases: ['chatgpt', 'chat gpt'],
      domainVariants: ['chatgpt.com'],
      promptDestination: 'chatgpt.com',
    },
    {
      id: 'google',
      label: 'Google',
      canonicalDomain: 'google.com',
      family: 'google',
      aliases: ['google'],
      domainVariants: ['google.com'],
      promptDestination: 'google.com',
    },
    {
      id: 'walmart',
      label: 'Walmart',
      canonicalDomain: 'walmart.com',
      family: 'walmart',
      aliases: ['walmart'],
      domainVariants: ['walmart.com'],
      promptDestination: 'walmart.com',
    },
    {
      id: 'etsy',
      label: 'Etsy',
      canonicalDomain: 'etsy.com',
      family: 'etsy',
      aliases: ['etsy'],
      domainVariants: ['etsy.com'],
      promptDestination: 'etsy.com',
    },
    {
      id: 'target',
      label: 'Target',
      canonicalDomain: 'target.com',
      family: 'target',
      aliases: ['target'],
      domainVariants: ['target.com'],
    },
    {
      id: 'bestbuy',
      label: 'Best Buy',
      canonicalDomain: 'bestbuy.com',
      family: 'bestbuy',
      aliases: ['best buy', 'bestbuy'],
      domainVariants: ['bestbuy.com'],
    },
    {
      id: 'costco',
      label: 'Costco',
      canonicalDomain: 'costco.com',
      family: 'costco',
      aliases: ['costco'],
      domainVariants: ['costco.com'],
    },
    {
      id: 'newegg',
      label: 'Newegg',
      canonicalDomain: 'newegg.com',
      family: 'newegg',
      aliases: ['newegg'],
      domainVariants: ['newegg.com'],
    },
    {
      id: 'wayfair',
      label: 'Wayfair',
      canonicalDomain: 'wayfair.com',
      family: 'wayfair',
      aliases: ['wayfair'],
      domainVariants: ['wayfair.com'],
    },
    {
      id: 'airbnb',
      label: 'Airbnb',
      canonicalDomain: 'airbnb.com',
      family: 'airbnb',
      aliases: ['airbnb'],
      domainVariants: ['airbnb.com'],
    },
    {
      id: 'booking',
      label: 'Booking.com',
      canonicalDomain: 'booking.com',
      family: 'booking',
      aliases: ['booking', 'booking.com'],
      domainVariants: ['booking.com'],
    },
    {
      id: 'indeed',
      label: 'Indeed',
      canonicalDomain: 'indeed.com',
      family: 'indeed',
      aliases: ['indeed'],
      domainVariants: ['indeed.com'],
    },
    {
      id: 'gemini',
      label: 'Gemini',
      canonicalDomain: 'gemini.google.com',
      family: 'google',
      aliases: ['gemini'],
      domainVariants: ['gemini.google.com'],
    },
    {
      id: 'claude',
      label: 'Claude',
      canonicalDomain: 'claude.ai',
      family: 'claude',
      aliases: ['claude'],
      domainVariants: ['claude.ai'],
    },
    {
      id: 'perplexity',
      label: 'Perplexity',
      canonicalDomain: 'perplexity.ai',
      family: 'perplexity',
      aliases: ['perplexity'],
      domainVariants: ['perplexity.ai'],
    },
    {
      id: 'copilot',
      label: 'Copilot',
      canonicalDomain: 'copilot.microsoft.com',
      family: 'microsoft',
      aliases: ['copilot'],
      domainVariants: ['copilot.microsoft.com'],
    },
    {
      id: 'otto',
      label: 'Otto',
      canonicalDomain: 'otto.de',
      family: 'otto',
      aliases: ['otto'],
      domainVariants: ['otto.de'],
      promptDestination: 'https://www.otto.de',
      searchUrl: 'https://www.otto.de/suche/{query}',
    },
  ];

  function normalizeDomainLike(input) {
    if (!input) return '';
    let value = String(input).trim().toLowerCase();
    value = value.replace(/^https?:\/\//, '');
    value = value.replace(/^www\./, '');
    value = value.split('/')[0].split('?')[0].split('#')[0];
    return value;
  }

  function normalizeAlias(input) {
    return String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function toAliasPattern(alias) {
    return escapeRegex(alias).replace(/\s+/g, '\\s+');
  }

  const siteDefinitions = SITE_REGISTRY.map((site) => ({
    ...site,
    normalizedCanonicalDomain: normalizeDomainLike(site.canonicalDomain),
    normalizedVariants: [...new Set([site.canonicalDomain, ...(site.domainVariants || [])].map(normalizeDomainLike))],
    normalizedAliases: [...new Set([site.id, ...(site.aliases || [])].map(normalizeAlias))],
  }));

  const sitesByDomain = new Map();
  const sitesByAlias = new Map();
  const mentionPatterns = [];

  for (const site of siteDefinitions) {
    for (const domain of site.normalizedVariants) {
      sitesByDomain.set(domain, site);
    }

    for (const alias of [...site.normalizedAliases, ...site.normalizedVariants]) {
      if (!sitesByAlias.has(alias)) {
        sitesByAlias.set(alias, site);
      }
      mentionPatterns.push({
        site,
        alias,
        score: alias.replace(/\s+/g, '').length + site.normalizedCanonicalDomain.length,
        regex: new RegExp(`\\b${toAliasPattern(alias)}\\b`, 'i'),
      });
    }
  }

  mentionPatterns.sort((a, b) => b.score - a.score);

  function getSiteByAlias(alias) {
    return sitesByAlias.get(normalizeAlias(alias)) || null;
  }

  function getSiteByDomain(domain) {
    return sitesByDomain.get(normalizeDomainLike(domain)) || null;
  }

  function getSiteDefinition(input) {
    return getSiteByDomain(input) || getSiteByAlias(input);
  }

  function resolveCanonicalDomain(input) {
    const normalized = normalizeDomainLike(input);
    if (!normalized) return '';
    if (sitesByDomain.has(normalized)) return normalized;

    const site = getSiteByAlias(input);
    if (site) return site.normalizedCanonicalDomain;
    if (!normalized.includes('.')) return `${normalized}.com`;
    return normalized;
  }

  function getDomainFamily(domain) {
    const normalized = normalizeDomainLike(domain);
    if (!normalized) return null;

    const site = getSiteByDomain(normalized);
    if (site) return site.family || site.id;

    if (/\.google\.com$/.test(normalized) || normalized === 'google.com') return 'google';
    if (/\.microsoft\.com$/.test(normalized) || normalized === 'microsoft.com') return 'microsoft';
    if (/^hotmail\./.test(normalized)) return 'outlook';
    if (/^gmail\./.test(normalized)) return 'gmail';
    if (/^yahoo\./.test(normalized)) return 'yahoo';
    return normalized;
  }

  function domainsAreEquivalent(a, b) {
    if (!a || !b) return false;
    return getDomainFamily(a) === getDomainFamily(b);
  }

  function preferCurrentDomain(requestedDomain, currentDomain) {
    const normalizedCurrent = normalizeDomainLike(currentDomain);
    const resolvedRequested = resolveCanonicalDomain(requestedDomain);
    if (normalizedCurrent && domainsAreEquivalent(resolvedRequested, normalizedCurrent)) {
      return normalizedCurrent;
    }
    return resolvedRequested;
  }

  function scrubEmails(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, ' ');
  }

  function findMentionedSites(text) {
    const searchable = scrubEmails(text);
    const seen = new Set();
    const matches = [];

    for (const candidate of mentionPatterns) {
      if (candidate.regex.test(searchable) && !seen.has(candidate.site.id)) {
        seen.add(candidate.site.id);
        matches.push(candidate);
      }
    }

    return matches;
  }

  function findExplicitDomainsInText(text) {
    const searchable = scrubEmails(text);
    const matches = [];
    const seen = new Set();
    const domainPattern = /\b(?:https?:\/\/)?(?:www\.)?(([a-z0-9-]+\.)+[a-z]{2,24})\b/gi;
    let match;

    while ((match = domainPattern.exec(searchable)) !== null) {
      const normalized = normalizeDomainLike(match[1]);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      matches.push(normalized);
    }

    return matches;
  }

  function canonicalizeExplicitSiteTarget(input) {
    const normalized = normalizeDomainLike(input);
    if (!normalized) return '';
    if (sitesByDomain.has(normalized)) return normalized;

    const site = getSiteByAlias(input);
    if (site) return site.normalizedCanonicalDomain;
    if (normalized.includes('.')) return normalized;
    return normalizeAlias(input);
  }

  function normalizeExplicitSiteHint(siteHint) {
    if (!siteHint || !Array.isArray(siteHint.explicitSites)) return null;

    const explicitSites = [...new Set(
      siteHint.explicitSites
        .map(canonicalizeExplicitSiteTarget)
        .filter(Boolean)
    )];

    if (explicitSites.length === 0) return null;

    return {
      explicitSites,
      onlyThese: siteHint.onlyThese !== false,
    };
  }

  function extractExplicitSiteHint(text) {
    const knownSites = findMentionedSites(text).map((match) => match.site.normalizedCanonicalDomain);
    const explicitDomains = findExplicitDomainsInText(text);
    const explicitSites = [...new Set([...knownSites, ...explicitDomains])];

    if (explicitSites.length === 0) return null;

    return {
      explicitSites,
      onlyThese: true,
    };
  }

  function mergeExplicitSiteHint(siteHint, text) {
    const normalizedHint = normalizeExplicitSiteHint(siteHint);
    const derivedHint = extractExplicitSiteHint(text);

    if (!normalizedHint) return derivedHint;
    if (!derivedHint) return normalizedHint;

    return {
      explicitSites: [...new Set([...normalizedHint.explicitSites, ...derivedHint.explicitSites])],
      onlyThese: normalizedHint.onlyThese !== false && derivedHint.onlyThese !== false,
    };
  }

  function countMentionedSiteTargets(text) {
    return extractExplicitSiteHint(text)?.explicitSites?.length || 0;
  }

  function detectPrimaryDomainFromText(text, options = {}) {
    const bestMatch = findMentionedSites(text)[0];
    if (bestMatch) {
      return preferCurrentDomain(bestMatch.alias, options.currentDomain);
    }

    const explicitDomain = findExplicitDomainsInText(text)[0];
    if (explicitDomain) {
      return preferCurrentDomain(explicitDomain, options.currentDomain);
    }

    return normalizeDomainLike(options.currentDomain) || null;
  }

  function getAliasesForDomain(domain) {
    const site = getSiteDefinition(domain);
    if (!site) return [];
    return [...new Set([...site.normalizedAliases, ...site.normalizedVariants])];
  }

  function getKnownSearchTemplate(domain) {
    const site = getSiteDefinition(domain);
    if (!site || !site.searchUrl) return null;
    return {
      domain: site.normalizedCanonicalDomain,
      searchUrl: site.searchUrl,
      name: `${site.id}_search`,
      notes: `Deterministic search template from the shared site registry for ${site.label}.`,
    };
  }

  function buildPromptUrlMap() {
    const lines = siteDefinitions
      .filter((site) => site.promptDestination)
      .map((site) => `- ${site.label} -> ${site.promptDestination}`);
    return `KNOWN URLS (navigate directly - never ask for these):\n${lines.join('\n')}`;
  }

  return {
    SITE_REGISTRY: siteDefinitions,
    normalizeDomainLike,
    resolveCanonicalDomain,
    getDomainFamily,
    domainsAreEquivalent,
    preferCurrentDomain,
    findMentionedSites,
    findExplicitDomainsInText,
    detectPrimaryDomainFromText,
    getAliasesForDomain,
    getKnownSearchTemplate,
    buildPromptUrlMap,
    extractExplicitSiteHint,
    normalizeExplicitSiteHint,
    mergeExplicitSiteHint,
    countMentionedSiteTargets,
  };
});
