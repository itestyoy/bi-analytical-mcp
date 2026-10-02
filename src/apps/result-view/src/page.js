// THE PAGE — the App this view is (the official MCP Apps App; its handlers are registered in
// mcp-app.js before it connects), the elements every card draws into, and the state of what is on screen.

import { App } from '@modelcontextprotocol/ext-apps';

export const log = {
  info: console.log.bind(console, '[APP]'),
  error: console.error.bind(console, '[APP]'),
};

// DOM element references
export const mainEl = document.querySelector('.main');

export const titleEl = document.getElementById('title');

export const subtitleEl = document.getElementById('subtitle');

export const noticeEl = document.getElementById('notice');

export const chartSection = document.getElementById('chart-section');

export const chartTitleEl = document.getElementById('chart-title');

export const chartDescriptionEl = document.getElementById('chart-description');

export const chartCanvas = document.getElementById('chart');

export const chartTooltip = document.getElementById('chart-tooltip');

export const chartLegend = document.getElementById('chart-legend');

export const cardsSection = document.getElementById('cards-section');

export const notesEl = document.getElementById('notes');

export const notesList = document.getElementById('notes-list');

export const fullscreenBtn = document.getElementById('fullscreen-btn');

export const backBtn = document.getElementById('back-btn');

export const chartCrumbs = document.getElementById('chart-crumbs');

export const chartMenu = document.getElementById('chart-menu');

export const chartLoading = document.getElementById('chart-loading');

export const loadingEl = document.getElementById('loading');

export const statusEl = document.getElementById('status');

// App state
export const state = {
  toolName: null,
  toolInput: null,
  chart: null,
  current: null, // the view model on screen
  drill: [], // the drill-down path: { model, crumb } from the result as it came to the view on screen
  displayMode: 'inline',
};

// the App this view is (the template's first step); mcp-app.js registers its handlers, then connects
export const app = new App({ name: 'Query Result', version: '1.0.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });
