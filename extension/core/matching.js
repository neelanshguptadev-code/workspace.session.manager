/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const TITLE_MATCH = 30;
const TAG_MATCH = 40;
const CONTEXT_MATCH = 100;
const ROLE_MATCH = 12;
const WORKSPACE_MATCH = 8;
const MONITOR_MATCH = 8;
const GEOMETRY_MATCH = 6;
const STATE_MATCH = 3;
const UNIQUE_APP_MATCH = 18;
const ACCEPT_SCORE = 28;
const TIE_MARGIN = 8;

export function appIdentity(app) {
    if (!app)
        return null;
    if (app.desktopId)
        return `desktop:${app.desktopId.toLowerCase()}`;
    if (app.gtkApplicationId)
        return `gtk:${app.gtkApplicationId.toLowerCase()}`;
    if (app.sandboxedAppId)
        return `sandbox:${app.sandboxedAppId.toLowerCase()}`;
    if (app.wmClass && app.wmClassInstance)
        return `class:${app.wmClass.toLowerCase()}|${app.wmClassInstance.toLowerCase()}`;
    if (app.wmClass)
        return `class:${app.wmClass.toLowerCase()}`;
    return null;
}

function normalizeTitle(title) {
    if (typeof title !== 'string')
        return '';
    return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function titlesOverlap(savedTitle, liveTitle) {
    const shorter = savedTitle.length <= liveTitle.length ? savedTitle : liveTitle;
    const longer = shorter === savedTitle ? liveTitle : savedTitle;
    if (shorter.length < 12)
        return false;
    return longer.includes(shorter);
}

function contextKey(context) {
    if (!context || !context.provider || !context.data)
        return null;
    try {
        return `${context.provider}:${JSON.stringify(context.data)}`;
    } catch {
        return null;
    }
}

/**
 * A live window is a different document, folder, or project when both sides
 * know their context and those contexts differ, or when the saved window has a
 * context and the open window's title is a different one.
 */
function savedContextUnsatisfied(saved, live) {
    const savedKey = contextKey(saved.context);
    if (!savedKey)
        return false;
    const liveKey = contextKey(live.context);
    if (liveKey)
        return savedKey !== liveKey;
    const savedTitle = normalizeTitle(saved.title);
    const liveTitle = normalizeTitle(live.title);
    if (!savedTitle || !liveTitle)
        return false;
    return savedTitle !== liveTitle && !titlesOverlap(savedTitle, liveTitle);
}

function frameCloseness(a, b) {
    if (!a || !b)
        return false;
    const cxA = a.x + a.width / 2;
    const cyA = a.y + a.height / 2;
    const cxB = b.x + b.width / 2;
    const cyB = b.y + b.height / 2;
    const center = Math.hypot(cxA - cxB, cyA - cyB) <= 96;
    const size = Math.abs(a.width - b.width) <= Math.max(48, a.width * 0.2) &&
        Math.abs(a.height - b.height) <= Math.max(48, a.height * 0.2);
    return center && size;
}

function monitorHint(saved, live) {
    if (saved.monitorSerial && live.monitorSerial && saved.monitorSerial === live.monitorSerial)
        return true;
    if (saved.monitorConnector && live.monitorConnector && saved.monitorConnector === live.monitorConnector)
        return true;
    return false;
}

export function scoreMatch(saved, live) {
    const savedApp = appIdentity(saved.app);
    const liveApp = appIdentity(live.app);
    if (!savedApp || savedApp !== liveApp)
        return { score: 0, reasons: ['different-app'] };

    let score = 0;
    const reasons = ['same-app'];
    const savedContext = contextKey(saved.context);
    const liveContext = contextKey(live.context);
    if (savedContext && savedContext === liveContext) {
        score += CONTEXT_MATCH;
        reasons.push('context');
    }
    if (saved.tag && live.tag && saved.tag === live.tag) {
        score += TAG_MATCH;
        reasons.push('tag');
    }
    if (saved.role && live.role && saved.role === live.role) {
        score += ROLE_MATCH;
        reasons.push('role');
    }

    const savedTitle = normalizeTitle(saved.title);
    const liveTitle = normalizeTitle(live.title);
    if (savedTitle && liveTitle && savedTitle === liveTitle) {
        score += TITLE_MATCH;
        reasons.push('title');
    } else if (savedTitle && liveTitle && titlesOverlap(savedTitle, liveTitle)) {
        score += Math.floor(TITLE_MATCH / 2);
        reasons.push('title-partial');
    }

    if (Number.isInteger(saved.workspaceIndex) && saved.workspaceIndex === live.workspaceIndex) {
        score += WORKSPACE_MATCH;
        reasons.push('workspace');
    }
    if (monitorHint(saved, live)) {
        score += MONITOR_MATCH;
        reasons.push('monitor');
    }
    if (frameCloseness(saved.frame, live.frame)) {
        score += GEOMETRY_MATCH;
        reasons.push('geometry');
    }
    if (saved.state && live.state &&
        saved.state.maximizedHorizontally === live.state.maximizedHorizontally &&
        saved.state.maximizedVertically === live.state.maximizedVertically &&
        saved.state.fullscreen === live.state.fullscreen) {
        score += STATE_MATCH;
        reasons.push('state');
    }
    return { score, reasons };
}

function countByApp(windows) {
    const counts = new Map();
    for (const windowRecord of windows) {
        const id = appIdentity(windowRecord.app);
        if (!id)
            continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
}

export function resolveMonitor(saved, liveMonitors) {
    const monitors = liveMonitors ?? [];
    if (saved.monitorSerial) {
        const bySerial = monitors.find(monitor => monitor.serial && monitor.serial === saved.monitorSerial);
        if (bySerial)
            return { index: bySerial.index, reason: 'serial', fallback: false };
    }
    if (saved.monitorConnector) {
        const byConnector = monitors.find(monitor => monitor.connector && monitor.connector === saved.monitorConnector);
        if (byConnector)
            return { index: byConnector.index, reason: 'connector', fallback: false };
    }
    if (Number.isInteger(saved.monitorIndex)) {
        const byIndex = monitors.find(monitor => monitor.index === saved.monitorIndex);
        if (byIndex)
            return { index: byIndex.index, reason: 'index', fallback: false };
    }
    const primary = monitors.find(monitor => monitor.primary) ?? monitors[0] ?? null;
    return {
        index: primary ? primary.index : 0,
        reason: 'primary-fallback',
        fallback: true,
    };
}

function sameInt(a, b) {
    return Number.isInteger(a) && Number.isInteger(b) && a === b;
}

function geometryNeedsMove(saved, live) {
    if (!saved.frame || !live.frame)
        return false;
    if (saved.state?.fullscreen || saved.state?.maximizedHorizontally || saved.state?.maximizedVertically)
        return false;
    return Math.abs(saved.frame.x - live.frame.x) > 16 ||
        Math.abs(saved.frame.y - live.frame.y) > 16 ||
        Math.abs(saved.frame.width - live.frame.width) > 16 ||
        Math.abs(saved.frame.height - live.frame.height) > 16;
}

function stateNeedsChange(saved, live) {
    const s = saved.state;
    const l = live.state;
    if (!s || !l)
        return false;
    return s.maximizedHorizontally !== l.maximizedHorizontally ||
        s.maximizedVertically !== l.maximizedVertically ||
        s.fullscreen !== l.fullscreen ||
        s.minimized !== l.minimized ||
        s.above !== l.above;
}

function describeWindow(windowRecord) {
    return windowRecord.app?.name || windowRecord.app?.desktopId || windowRecord.title || 'Window';
}

const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.desktop$/;

function skipAction(saved, reason) {
    return {
        type: 'skip',
        savedKey: saved.key,
        liveId: null,
        label: describeWindow(saved),
        reason,
        changes: [],
    };
}

function launchChanges(saved, monitor) {
    const changes = [];
    if (saved.onAllWorkspaces)
        changes.push('stick');
    else if (Number.isInteger(saved.workspaceIndex))
        changes.push('workspace');
    if (Number.isInteger(monitor.index))
        changes.push('monitor');
    if (saved.frame && !saved.state?.fullscreen && !saved.state?.maximizedHorizontally && !saved.state?.maximizedVertically)
        changes.push('geometry');
    if (saved.state)
        changes.push('state');
    return changes;
}

function launchReason(saved) {
    const urls = saved.context?.provider === 'chromium' ? saved.context.data?.urls : null;
    if (Array.isArray(urls) && urls.length > 0)
        return 'This browser window will open in its saved profile with its saved tabs.';
    if (saved.context?.provider === 'chromium')
        return 'This browser window will open in its saved profile.';
    if (saved.context?.provider === 'vscode' && (saved.context.data?.folder || saved.context.data?.workspaceFile))
        return 'This editor window will open its saved folder.';
    if (saved.context?.provider === 'directory')
        return 'This file window will open its saved folder.';
    if (saved.context?.provider === 'terminal')
        return 'This terminal will open in its saved directory.';
    if (saved.context?.provider === 'firefox')
        return 'This browser window will open its saved tabs.';
    if (saved.context?.provider === 'document')
        return 'This document will open its saved file.';
    return 'This application is not open, so it will be launched.';
}

export function progressText(action, index, total) {
    const verb = action?.type === 'launch' ? 'Opening' : 'Moving';
    return `${verb} ${action?.label || 'a window'}, ${index} of ${total}`;
}

function launchAction(saved, liveMonitors, session, savedAppCount) {
    const monitor = resolveMonitor(saved, liveMonitors);
    return {
        type: 'launch',
        savedKey: saved.key,
        liveId: null,
        desktopId: saved.app.desktopId,
        savedAppCount,
        label: describeWindow(saved),
        reason: launchReason(saved),
        title: saved.title ?? '',
        context: saved.context ?? null,
        changes: launchChanges(saved, monitor),
        workspaceIndex: saved.workspaceIndex,
        onAllWorkspaces: Boolean(saved.onAllWorkspaces),
        monitorIndex: monitor.index,
        monitorFallback: monitor.fallback,
        frame: saved.frame,
        state: saved.state,
        focus: session.focusedWindowKey === saved.key,
    };
}

/**
 * Build a merge plan. It never closes or kills windows.
 * A launch action opens one missing application window through its desktop id.
 */
export function planMerge(session, liveWindows, liveMonitors, liveEnvironment = null) {
    const savedWindows = session.windows ?? [];
    const live = liveWindows ?? [];
    const savedCounts = countByApp(savedWindows);
    const liveCounts = countByApp(live);
    const usedLive = new Set();
    const usedSaved = new Set();
    const actions = [];
    const notes = [];

    const savedDynamic = session.environment?.dynamicWorkspaces;
    const liveDynamic = liveEnvironment?.dynamicWorkspaces;
    if (typeof savedDynamic === 'boolean' && typeof liveDynamic === 'boolean' && savedDynamic !== liveDynamic) {
        notes.push('Workspace mode differs from the saved session. Windows are placed by index, and the mode setting is left as it is.');
    }

    const scored = [];
    for (const saved of savedWindows) {
        const savedApp = appIdentity(saved.app);
        const uniqueApp = savedApp && savedCounts.get(savedApp) === 1 && liveCounts.get(savedApp) === 1;
        for (const candidate of live) {
            if (savedContextUnsatisfied(saved, candidate))
                continue;
            const result = scoreMatch(saved, candidate);
            if (result.reasons.includes('different-app'))
                continue;
            let score = result.score;
            const reasons = [...result.reasons];
            if (uniqueApp) {
                score += UNIQUE_APP_MATCH;
                reasons.push('unique-app');
            }
            scored.push({ saved, live: candidate, score, reasons, uniqueApp });
        }
    }
    scored.sort((a, b) => b.score - a.score || a.saved.key.localeCompare(b.saved.key));

    for (const pair of scored) {
        if (usedSaved.has(pair.saved.key) || usedLive.has(pair.live.liveId))
            continue;
        const rivals = scored.filter(other => {
            return other.saved.key === pair.saved.key &&
                other.live.liveId !== pair.live.liveId &&
                !usedLive.has(other.live.liveId);
        });
        const second = rivals[0] ?? null;
        const tooClose = second && pair.score - second.score < TIE_MARGIN;
        const accepted = pair.score >= ACCEPT_SCORE || (pair.uniqueApp && pair.score >= UNIQUE_APP_MATCH);
        if (!accepted)
            continue;
        if (tooClose) {
            usedSaved.add(pair.saved.key);
            actions.push({
                type: 'skip',
                savedKey: pair.saved.key,
                liveId: null,
                label: describeWindow(pair.saved),
                reason: 'Two open windows look equally like this saved window, so it was left alone.',
                changes: [],
            });
            continue;
        }

        usedSaved.add(pair.saved.key);
        usedLive.add(pair.live.liveId);
        const monitor = resolveMonitor(pair.saved, liveMonitors);
        const changes = [];
        if (!pair.saved.onAllWorkspaces &&
            Number.isInteger(pair.saved.workspaceIndex) &&
            pair.saved.workspaceIndex !== pair.live.workspaceIndex)
            changes.push('workspace');
        if (Boolean(pair.saved.onAllWorkspaces) !== Boolean(pair.live.onAllWorkspaces))
            changes.push('stick');
        if (!sameInt(monitor.index, pair.live.monitorIndex))
            changes.push('monitor');
        if (geometryNeedsMove(pair.saved, pair.live))
            changes.push('geometry');
        if (stateNeedsChange(pair.saved, pair.live))
            changes.push('state');

        actions.push({
            type: changes.length === 0 ? 'keep' : 'move',
            savedKey: pair.saved.key,
            liveId: pair.live.liveId,
            label: describeWindow(pair.saved),
            reason: pair.reasons.join(', '),
            changes,
            workspaceIndex: pair.saved.workspaceIndex,
            onAllWorkspaces: pair.saved.onAllWorkspaces,
            monitorIndex: monitor.index,
            monitorFallback: monitor.fallback,
            frame: pair.saved.frame,
            state: pair.saved.state,
            focus: session.focusedWindowKey === pair.saved.key,
        });
    }

    const pendingByApp = new Map();
    for (const saved of savedWindows) {
        if (usedSaved.has(saved.key))
            continue;
        const desktopId = saved.app?.desktopId;
        const identity = appIdentity(saved.app);
        if (!identity || typeof desktopId !== 'string' || !DESKTOP_ID.test(desktopId)) {
            actions.push(skipAction(saved, 'This application has no desktop file, so it cannot be launched.'));
            continue;
        }
        if (!pendingByApp.has(identity))
            pendingByApp.set(identity, []);
        pendingByApp.get(identity).push(saved);
    }

    for (const [identity, pending] of pendingByApp) {
        const unclaimedLive = live.filter(windowRecord => {
            return appIdentity(windowRecord.app) === identity && !usedLive.has(windowRecord.liveId);
        });
        const flexible = pending.filter(saved => {
            return unclaimedLive.some(candidate => !savedContextUnsatisfied(saved, candidate));
        });
        const forced = pending.filter(saved => !flexible.includes(saved));
        const blocking = unclaimedLive.filter(candidate => {
            return flexible.some(saved => !savedContextUnsatisfied(saved, candidate));
        });
        const launchCount = Math.max(0, flexible.length - blocking.length);
        flexible.forEach((saved, index) => {
            if (index < launchCount) {
                actions.push(launchAction(saved, liveMonitors, session, savedCounts.get(identity) ?? pending.length));
                return;
            }
            actions.push(skipAction(
                saved,
                'Enough windows of this application are already open, but they could not be matched. No extra copy will be opened.',
            ));
        });
        for (const saved of forced)
            actions.push(launchAction(saved, liveMonitors, session, savedCounts.get(identity) ?? pending.length));
    }

    const unrelated = live.filter(windowRecord => !usedLive.has(windowRecord.liveId)).length;
    return {
        actions,
        notes,
        summary: {
            move: actions.filter(action => action.type === 'move').length,
            keep: actions.filter(action => action.type === 'keep').length,
            launch: actions.filter(action => action.type === 'launch').length,
            skip: actions.filter(action => action.type === 'skip').length,
            unrelated,
            activeWorkspaceIndex: session.activeWorkspaceIndex,
        },
    };
}

export function summarizePlan(plan) {
    const { summary } = plan;
    const parts = [
        `Move ${summary.move}`,
        `already placed ${summary.keep}`,
    ];
    if (summary.launch)
        parts.push(`open ${summary.launch}`);
    parts.push(
        `not restored ${summary.skip}`,
        `leave ${summary.unrelated} unrelated`,
    );
    return `${parts.join(', ')}. Nothing will be closed.`;
}
