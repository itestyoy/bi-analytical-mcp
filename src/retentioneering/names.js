// The feature's side and its three tools, by name — what every part of it refers to — and the fixed
// columns of every eventstream. A leaf: it imports nothing, so any module of the feature can read it.

export const SIDE = 'retentioneering';

export const BUILD = 'build_retentioneering_model';

export const QUERY = 'query_retentioneering_model';

export const DISPLAY = 'display_retentioneering_result';

/** The fixed columns of every eventstream (segment columns come after them). */
export const ES_COLUMNS = { user: 'user_id', event: 'event', time: 'event_time', session: 'session_id' };
