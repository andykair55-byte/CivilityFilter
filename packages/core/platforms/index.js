/**
 * platforms/index.js — Platform Registry
 *
 * Auto-detects the current platform by hostname and returns the matching adapter.
 * Each adapter exports a standard shape (see below).
 */

import { TwitterPlatform }  from './twitter.js';
import { RedditPlatform }   from './reddit.js';
import { YoutubePlatform }  from './youtube.js';
import { WeiboPlatform }    from './weibo.js';
import { BilibiliPlatform } from './bilibili.js';
import { ZhihuPlatform }    from './zhihu.js';
import { TiebaPlatform }    from './tieba.js';
import { GenericPlatform }  from './generic.js';

// ── Platform adapter interface (all adapters must implement this shape) ─────────
//
//  {
//    name:      string,           // display name
//    hostnames: string[],         // matched against location.hostname
//
//    selectors: {
//      commentContainer: string,  // each individual comment/reply wrapper
//      commentText:      string,  // element containing the text (relative to container)
//      username:         string,  // element containing the username
//      replyContainer:   string,  // optional: wrapper that marks this as a reply
//    },
//
//    blockStrategy: Function | null,
//    // (username: string, sourceElement: Element) => void
//    // Executes the platform's native block/mute via DOM interaction.
//  }

const REGISTRY = [
  TwitterPlatform,
  RedditPlatform,
  YoutubePlatform,
  WeiboPlatform,
  BilibiliPlatform,
  ZhihuPlatform,
  TiebaPlatform,
];

export const PlatformRegistry = {
  detect() {
    const host = location.hostname.replace(/^www\./, '');
    return REGISTRY.find(p => p.hostnames.some(h => host === h || host.endsWith('.' + h)))
      || GenericPlatform;
  },
};

export { GenericPlatform };
