import { ttStorage } from "@common/utils/context";
import { ttCache } from "@common/utils/data/cache";
import { filters, settings } from "@common/utils/data/database";
import { LAST_ACTION_FILTER_MAX, NETWORTH_FILTER_MAX } from "@common/utils/data/default-database";
import { createTextbox } from "@common/utils/elements/textbox/textbox";
import { hasAPIData } from "@common/utils/functions/api";
import { fetchData } from "@common/utils/functions/api-fetcher";
import { createContainer, findContainer, removeContainer } from "@common/utils/functions/containers";
import { elementBuilder, findAllElements } from "@common/utils/functions/dom";
import {
	createFilterEnabledFunnel,
	createFilterSection,
	createStatistics,
	defaultFactionsItems,
	FILTER_REGEXES,
	getSpecialIcons,
	type SpecialFilterValue,
} from "@common/utils/functions/filters";
import { convertToNumber, formatNumber } from "@common/utils/functions/formatting";
import { CUSTOM_LISTENERS, EVENT_CHANNELS, triggerCustomListener } from "@common/utils/functions/listeners";
import { requireElement } from "@common/utils/functions/requires";
import { isAbroad, RANK_TRIGGERS, SPECIAL_FILTER_ICONS } from "@common/utils/functions/torn";
import { sleep, TO_MILLIS } from "@common/utils/functions/utilities";
import { Feature } from "@features/feature";
import { hasStatsEstimatesLoaded } from "@features/stats-estimate/stats-estimate";
import type { UserPersonalStatsPopular, UserProfileResponse } from "tornapi-typescript";

const localFilters: any = {};

const USER_DATA_CACHE_SECTION = "abroad-filter-networth-last-action";
const USER_DATA_FETCH_DELAY = TO_MILLIS.SECONDS * 1.5;
const SECONDS_PER = {
	YEAR: 60 * 60 * 24 * 365,
	MONTH: 60 * 60 * 24 * 30,
	DAY: 60 * 60 * 24,
	HOUR: 60 * 60,
	MINUTE: 60,
} as const;

interface UserNetworthLastAction {
	networth: number;
	lastAction: number;
}

interface UserDataQueueItem {
	row: HTMLElement;
	id: number;
}

let userDataQueue: UserDataQueueItem[] = [];
let userDataRunning = false;

function formatNetworthLabel(value: number): string {
	return `${formatNumber(value, { shorten: 3, currency: true })}${value >= NETWORTH_FILTER_MAX ? "+" : ""}`;
}

function formatDurationLabel(seconds: number): string {
	const value = Math.max(seconds, 0);
	const suffix = value >= LAST_ACTION_FILTER_MAX ? "+" : "";

	let amount: number, unit: string;
	if (value >= SECONDS_PER.YEAR) [amount, unit] = [value / SECONDS_PER.YEAR, "y"];
	else if (value >= SECONDS_PER.MONTH) [amount, unit] = [value / SECONDS_PER.MONTH, "mo"];
	else if (value >= SECONDS_PER.DAY) [amount, unit] = [value / SECONDS_PER.DAY, "d"];
	else if (value >= SECONDS_PER.HOUR) [amount, unit] = [value / SECONDS_PER.HOUR, "h"];
	else if (value >= SECONDS_PER.MINUTE) [amount, unit] = [value / SECONDS_PER.MINUTE, "m"];
	else return `${Math.round(value)}s${suffix}`;

	return `${Math.round(amount * 10) / 10}${unit}${suffix}`;
}

function loadUserData() {
	const rows = findAllElements(".users-list > li").filter(
		(row) => !(row.classList.contains("tt-hidden") && row.dataset.hideReason !== "networth" && row.dataset.hideReason !== "last-action"),
	);

	for (const row of rows) {
		const link = row.querySelector<HTMLAnchorElement>(".user.name[href*='profiles.php']");
		if (!link) continue;

		const id = parseInt(link.href.match(/(?<=XID=).*/)[0]);
		if (Number.isNaN(id)) continue;

		userDataQueue.push({ row, id });
	}

	return runUserDataQueue();
}

async function runUserDataQueue() {
	if (userDataRunning) return;

	userDataRunning = true;

	while (userDataQueue.length) {
		const { row, id } = userDataQueue.shift();

		if (row.classList.contains("tt-hidden") && row.dataset.hideReason !== "networth" && row.dataset.hideReason !== "last-action") continue;

		try {
			const { networth, lastAction } = await fetchUserData(id);

			row.dataset.networth = networth.toString();
			row.dataset.lastAction = lastAction.toString();

			applyUserData(row);
		} catch (error) {
			console.error("TT - Failed to load networth/last action data.", error);
		}

		await sleep(USER_DATA_FETCH_DELAY);
	}

	userDataRunning = false;
}

async function fetchUserData(id: number): Promise<UserNetworthLastAction> {
	if (ttCache.hasValue(USER_DATA_CACHE_SECTION, id)) {
		return ttCache.get<UserNetworthLastAction>(USER_DATA_CACHE_SECTION, id);
	}

	const data = await fetchData<UserProfileResponse & UserPersonalStatsPopular>("tornv2", {
		section: "user",
		id,
		selections: ["profile", "personalstats"],
		params: { cat: "popular" },
		silent: true,
	});

	const result: UserNetworthLastAction = {
		networth: data.personalstats.networth.total,
		lastAction: data.profile.last_action.timestamp,
	};

	ttCache
		.set({ [id]: result }, TO_MILLIS.HOURS, USER_DATA_CACHE_SECTION)
		.catch((error) => console.error("TT - Failed to cache networth/last action data.", error));

	return result;
}

function applyUserData(row: HTMLElement) {
	if (!localFilters.enabled?.isEnabled()) return;
	if (row.classList.contains("tt-hidden") && row.dataset.hideReason !== "networth" && row.dataset.hideReason !== "last-action") return;

	const content = findContainer("People Filter", { selector: "main" });
	const networthRange = localFilters["Networth Filter"]?.getStartEnd(content);
	const lastActionRange = localFilters["Last Action Filter"]?.getStartEnd(content);

	filterRow(
		row,
		{
			networth: networthRange ? { start: parseFloat(networthRange.start), end: parseFloat(networthRange.end) } : undefined,
			lastAction: lastActionRange ? { start: parseFloat(lastActionRange.start), end: parseFloat(lastActionRange.end) } : undefined,
		},
		true,
	);
}

function initialiseFilters() {
	CUSTOM_LISTENERS[EVENT_CHANNELS.STATS_ESTIMATED].push(({ row }) => {
		const content = findContainer("People Filter", { selector: "main" });
		const statsEstimates = localFilters["Stats Estimate"]?.getSelections(content);
		if (!statsEstimates?.length) return;

		filterRow(row, { statsEstimates }, true);
	});
	CUSTOM_LISTENERS[EVENT_CHANNELS.FF_SCOUTER_GAUGE].push(async () => {
		if (!localFilters["FF Score Max"]?.getValue() && !localFilters["FF Score Min"]?.getValue()) return;

		await applyFilters();
	});
}

async function addFilters() {
	await requireElement(".users-list");

	const { content, options } = createContainer("People Filter", {
		class: "mt10",
		nextElement: document.querySelector(".users-list-title"),
		filter: true,
	});

	const statistics = createStatistics("players");
	content.appendChild(statistics.element);
	localFilters["Statistics"] = { updateStatistics: statistics.updateStatistics };

	const filterContent = elementBuilder({
		type: "div",
		class: "content",
	});

	const activityFilter = createFilterSection({
		type: "Activity",
		defaults: filters.abroadPeople.activity,
		callback: () => applyFilters(),
	});
	filterContent.appendChild(activityFilter.element);
	localFilters["Activity"] = { getSelections: activityFilter.getSelections };

	const onPageFactions = getFactions();
	const isPreviousFactionSelectionPresent =
		!["", "No faction", "Unknown faction", "In a faction"].includes(filters.abroadPeople.faction) &&
		onPageFactions.some((option) => option.value === filters.abroadPeople.faction);
	const factionFilter = createFilterSection({
		title: "Faction",
		select: [
			...(isPreviousFactionSelectionPresent || !filters.abroadPeople.faction
				? []
				: [{ value: filters.abroadPeople.faction, description: filters.abroadPeople.faction }]),
			...defaultFactionsItems,
			...onPageFactions,
		],
		default: filters.abroadPeople.faction,
		callback: () => applyFilters(),
	});
	filterContent.appendChild(factionFilter.element);
	localFilters["Faction"] = { getSelected: factionFilter.getSelected };

	const specialFilter = createFilterSection({
		title: "Special",
		ynCheckboxes: ["New Player", "In Company", "In Faction", "Is Donator", "Has Bounties", "Bazaar Open"],
		defaults: filters.abroadPeople.special,
		callback: () => applyFilters(),
	});
	filterContent.appendChild(specialFilter.element);
	localFilters["Special"] = { getSelections: specialFilter.getSelections };

	const statusFilter = createFilterSection({
		title: "Status",
		checkboxes: [
			{ id: "okay", description: "Okay" },
			{ id: "hospital", description: "Hospital" },
		],
		defaults: filters.abroadPeople.status,
		callback: () => applyFilters(),
	});
	filterContent.appendChild(statusFilter.element);
	localFilters["Status"] = { getSelections: statusFilter.getSelections };

	const levelFilter = createFilterSection({
		type: "LevelAll",
		typeData: {
			valueLow: filters.abroadPeople.levelStart,
			valueHigh: filters.abroadPeople.levelEnd,
		},
		callback: () => applyFilters(),
	});
	filterContent.appendChild(levelFilter.element);
	content.appendChild(filterContent);
	localFilters["Level Filter"] = { getStartEnd: levelFilter.getStartEnd, updateCounter: levelFilter.updateCounter };

	if (hasAPIData()) {
		const networthFilter = createFilterSection({
			title: "Networth",
			noTitle: true,
			logSlider: {
				min: 0,
				max: NETWORTH_FILTER_MAX,
				minPositive: 1,
				valueLow: filters.abroadPeople.networthStart,
				valueHigh: filters.abroadPeople.networthEnd,
			},
			callback: () => applyFilters(),
		});
		filterContent.appendChild(networthFilter.element);
		localFilters["Networth Filter"] = { getStartEnd: networthFilter.getStartEnd, updateCounter: networthFilter.updateCounter };

		const lastActionFilter = createFilterSection({
			title: "Last Action",
			noTitle: true,
			logSlider: {
				min: 0,
				max: LAST_ACTION_FILTER_MAX,
				minPositive: 1,
				valueLow: filters.abroadPeople.lastActionStart,
				valueHigh: filters.abroadPeople.lastActionEnd,
			},
			callback: () => applyFilters(),
		});
		filterContent.appendChild(lastActionFilter.element);
		localFilters["Last Action Filter"] = { getStartEnd: lastActionFilter.getStartEnd, updateCounter: lastActionFilter.updateCounter };

		loadUserData().catch((error) => console.error("TT - Failed to load networth/last action data.", error));
	}

	if (settings.scripts.statsEstimate.global && settings.scripts.statsEstimate.userlist && hasAPIData()) {
		const estimatesFilter = createFilterSection({
			title: "Stats Estimates",
			checkboxes: [
				{ id: "none", description: "none" },
				...RANK_TRIGGERS.stats.map((trigger) => ({ id: trigger, description: trigger })),
				{ id: "n/a", description: "N/A" },
			],
			defaults: filters.abroadPeople.estimates,
			callback: () => applyFilters(),
		});
		filterContent.appendChild(estimatesFilter.element);

		localFilters["Stats Estimate"] = { getSelections: estimatesFilter.getSelections };
	}

	if (settings.scripts.ffScouter.gauge && settings.external.ffScouter && hasAPIData()) {
		const ffScoreFilterMin = createFilterSection({
			title: "FF Score Min",
			text: "number",
			default: filters.abroadPeople.ffScoreMin?.toString(),
			callback: () => applyFilters(),
		});
		ffScoreFilterMin.element.querySelector("input").step = 0.1;
		filterContent.appendChild(ffScoreFilterMin.element);
		localFilters["FF Score Min"] = { getValue: ffScoreFilterMin.getValue };

		const ffScoreFilterMax = createTextbox({
			type: "number",
		});
		ffScoreFilterMax.setValue(filters.abroadPeople.ffScoreMax?.toString());
		ffScoreFilterMax.onChange(applyFilters);
		ffScoreFilterMax.element.step = "0.1";

		ffScoreFilterMin.element.appendChild(elementBuilder({ type: "strong", text: "FF Score Max" }));
		ffScoreFilterMin.element.append(ffScoreFilterMax.element);
		localFilters["FF Score Max"] = { getValue: ffScoreFilterMax.getValue };
	}

	const enabledFunnel = createFilterEnabledFunnel();
	enabledFunnel.onChange(() => applyFilters());
	enabledFunnel.setEnabled(filters.abroadPeople.enabled);
	options.appendChild(enabledFunnel.element);
	localFilters.enabled = { isEnabled: enabledFunnel.isEnabled };

	await applyFilters();
}

async function applyFilters() {
	await requireElement(".users-list > li");

	// Get the set filters
	const content = findContainer("People Filter", { selector: "main" });

	const activity = localFilters["Activity"].getSelections(content);
	const faction = localFilters["Faction"].getSelected(content).trim();
	const special = localFilters["Special"].getSelections(content);
	const status = localFilters["Status"].getSelections(content);
	const levels = localFilters["Level Filter"].getStartEnd(content);
	const levelStart = parseInt(levels.start);
	const levelEnd = parseInt(levels.end);
	const statsEstimates =
		hasStatsEstimatesLoaded("Abroad People") && settings.scripts.statsEstimate.global && settings.scripts.statsEstimate.userlist && hasAPIData()
			? localFilters["Stats Estimate"]?.getSelections(content)
			: undefined;
	const ffScoreMin = parseFloat(localFilters["FF Score Min"]?.getValue()) ?? null;
	const ffScoreMax = parseFloat(localFilters["FF Score Max"]?.getValue()) ?? null;

	const networthRange = localFilters["Networth Filter"]?.getStartEnd(content);
	const networthStart = networthRange ? parseFloat(networthRange.start) : filters.abroadPeople.networthStart;
	const networthEnd = networthRange ? parseFloat(networthRange.end) : filters.abroadPeople.networthEnd;

	const lastActionRange = localFilters["Last Action Filter"]?.getStartEnd(content);
	const lastActionStart = lastActionRange ? parseFloat(lastActionRange.start) : filters.abroadPeople.lastActionStart;
	const lastActionEnd = lastActionRange ? parseFloat(lastActionRange.end) : filters.abroadPeople.lastActionEnd;

	// Update slider counters
	localFilters["Level Filter"].updateCounter(`Level ${levelStart} - ${levelEnd}`, content);
	localFilters["Networth Filter"]?.updateCounter(`Networth: ${formatNetworthLabel(networthStart)} - ${formatNetworthLabel(networthEnd)}`, content);
	localFilters["Last Action Filter"]?.updateCounter(`Last Action: ${formatDurationLabel(lastActionStart)} - ${formatDurationLabel(lastActionEnd)}`, content);

	// Save filters
	await ttStorage.change({
		filters: {
			abroadPeople: {
				enabled: localFilters.enabled.isEnabled(),
				activity,
				faction,
				special,
				status,
				levelStart,
				levelEnd,
				estimates: statsEstimates ?? filters.abroadPeople.estimates,
				ffScoreMax,
				ffScoreMin,
				networthStart,
				networthEnd,
				lastActionStart,
				lastActionEnd,
			},
		},
	});

	// Actual Filtering
	if (!localFilters.enabled.isEnabled()) {
		findAllElements(".users-list > li.tt-hidden").forEach((row) => {
			row.classList.remove("tt-hidden");
			delete row.dataset.hideReason;
		});
		localFilters["Statistics"].updateStatistics(
			findAllElements(".users-list > li:not(.tt-hidden)").length,
			findAllElements(".users-list > li").length,
			content,
		);
		return;
	}

	for (const row of findAllElements(".users-list > li")) {
		filterRow(
			row,
			{
				activity,
				faction,
				special,
				status,
				level: { start: levelStart, end: levelEnd },
				statsEstimates,
				ffScoreMin,
				ffScoreMax,
				networth: { start: networthStart, end: networthEnd },
				lastAction: { start: lastActionStart, end: lastActionEnd },
			},
			false,
		);
	}

	triggerCustomListener(EVENT_CHANNELS.FILTER_APPLIED, { filter: "People Filter" });

	localFilters["Statistics"].updateStatistics(
		findAllElements(".users-list > li:not(.tt-hidden)").length,
		findAllElements(".users-list > li").length,
		content,
	);
}

type AbroadPeopleFilters = {
	activity: string[];
	status: string[];
	level: {
		start: number;
		end: number;
	};
	faction: string;
	special: {
		newPlayer: SpecialFilterValue;
		inCompany: SpecialFilterValue;
		inFaction: SpecialFilterValue;
		isDonator: SpecialFilterValue;
		hasBounties: SpecialFilterValue;
		bazaarOpen: SpecialFilterValue;
	};
	statsEstimates: string[];
	ffScoreMax: number;
	ffScoreMin: number;
	networth: {
		start: number;
		end: number;
	};
	lastAction: {
		start: number;
		end: number;
	};
};

function filterRow(row: HTMLElement, filters: Partial<AbroadPeopleFilters>, individual: boolean) {
	if (filters.activity?.length) {
		if (
			!filters.activity.some(
				(x) => x.trim() === row.querySelector("#iconTray li").getAttribute("title").match(FILTER_REGEXES.activity)[0].toLowerCase().trim(),
			)
		) {
			hide("activity");
			return;
		}
	}
	if (filters.faction) {
		const factionElement = row.querySelector<HTMLAnchorElement>(".user.faction");

		const hasFaction = !!factionElement.href;
		const factionName = hasFaction
			? factionElement.hasAttribute("rel")
				? factionElement.querySelector(":scope > img").getAttribute("title").trim() || "N/A"
				: factionElement.textContent.trim()
			: false;
		const isUnknownFaction = hasFaction && factionName === "N/A";

		if (filters.faction === "No faction") {
			if (hasFaction) {
				hide("faction");
				return;
			}
		} else if (filters.faction === "Unknown faction") {
			if (!isUnknownFaction) {
				// Not "Unknown faction"
				hide("faction");
				return;
			}
		} else if (filters.faction === "In a faction") {
			if (!hasFaction) {
				hide("faction");
				return;
			}
		} else {
			if (
				!hasFaction || // No faction
				isUnknownFaction || // Unknown faction
				filters.faction !== factionName
			) {
				hide("faction");
				return;
			}
		}
	}
	if (filters.special) {
		const match = Object.entries(filters.special)
			.filter(([, value]) => value !== "both" && value !== "none")
			.find(([key, value]) => {
				const icons = getSpecialIcons(row);
				const filterIcons = SPECIAL_FILTER_ICONS[key];

				return (
					(value === "yes" && !icons.some((foundIcon) => filterIcons.includes(foundIcon))) ||
					(value === "no" && icons.some((foundIcon) => filterIcons.includes(foundIcon)))
				);
			});

		if (match) {
			hide(`special-${match[0]}`);
			return;
		}
	}
	if (filters.status?.length && filters.status.length !== 2) {
		const status = row.querySelector(".status :last-child").textContent.toLowerCase().trim();

		if (!filters.status.includes(status)) {
			hide("status");
			return;
		}
	}
	if (filters.level?.start || filters.level?.end) {
		const level = convertToNumber(row.querySelector(".level").textContent);
		if ((filters.level.start && level < filters.level.start) || (filters.level.end !== 100 && level > filters.level.end)) {
			hide("level");
			return;
		}
	}
	if (filters.statsEstimates) {
		if (filters.statsEstimates.length) {
			const estimate = row.dataset.estimate?.toLowerCase();
			if ((estimate || !row.classList.contains("tt-estimated")) && !filters.statsEstimates.includes(estimate)) {
				hide("stats-estimate");
				return;
			}
		}
	}
	if (filters.networth && (filters.networth.start > 0 || filters.networth.end < NETWORTH_FILTER_MAX)) {
		const networth = row.dataset.networth !== undefined ? parseFloat(row.dataset.networth) : undefined;

		if (
			networth === undefined ||
			(filters.networth.start > 0 && networth < filters.networth.start) ||
			(filters.networth.end < NETWORTH_FILTER_MAX && networth > filters.networth.end)
		) {
			hide("networth");
			return;
		}
	}
	if (filters.lastAction && (filters.lastAction.start > 0 || filters.lastAction.end < LAST_ACTION_FILTER_MAX)) {
		const lastActionTimestamp = row.dataset.lastAction !== undefined ? parseFloat(row.dataset.lastAction) : undefined;
		const elapsed = lastActionTimestamp !== undefined ? Date.now() / 1000 - lastActionTimestamp : undefined;

		if (
			elapsed === undefined ||
			(filters.lastAction.start > 0 && elapsed < filters.lastAction.start) ||
			(filters.lastAction.end < LAST_ACTION_FILTER_MAX && elapsed > filters.lastAction.end)
		) {
			hide("last-action");
			return;
		}
	}
	if (filters.ffScoreMax || filters.ffScoreMin) {
		try {
			const gauge = row.querySelector(".tt-ff-scouter-indicator.indicator-lines");
			if (gauge) {
				const ffFloat: number = parseFloat(gauge.getAttribute("data-ff-scout"));
				if (!Number.isNaN(ffFloat)) {
					if (filters.ffScoreMax && !Number.isNaN(filters.ffScoreMax) && ffFloat > filters.ffScoreMax) {
						hide("ff-score");
						return;
					}
					if (filters.ffScoreMin && !Number.isNaN(filters.ffScoreMin) && ffFloat < filters.ffScoreMin) {
						hide("ff-score");
						return;
					}
				}
			}
		} catch (error) {
			console.error("TT - Failed to filter row by FF Score.", error);
		}
	}

	show();

	function show() {
		row.classList.remove("tt-hidden");
		row.removeAttribute("data-hide-reason");

		if (row.nextElementSibling?.classList.contains("tt-stats-estimate")) {
			row.nextElementSibling.classList.remove("tt-hidden");
		}

		if (individual) {
			const content = findContainer("People Filter", { selector: "main" });

			localFilters["Statistics"].updateStatistics(
				findAllElements(".users-list > li:not(.tt-hidden)").length,
				findAllElements(".users-list > li").length,
				content,
			);
		}
	}

	function hide(reason: string) {
		row.classList.add("tt-hidden");
		row.dataset.hideReason = reason;

		if (row.nextElementSibling?.classList.contains("tt-stats-estimate")) {
			row.nextElementSibling.classList.add("tt-hidden");
		}

		if (individual) {
			const content = findContainer("People Filter", { selector: "main" });

			localFilters["Statistics"].updateStatistics(
				findAllElements(".users-list > li:not(.tt-hidden)").length,
				findAllElements(".users-list > li").length,
				content,
			);
		}
	}
}

function getFactions() {
	const rows = findAllElements(".users-list > li .user.faction");
	const _factions = new Set(
		rows[0].querySelector("img")
			? rows
					.map((row) => row.querySelector("img"))
					.filter((img) => !!img)
					.map((img) => img.getAttribute("title").trim())
					.filter((tag) => !!tag)
			: rows.map((row) => row.textContent.trim()).filter((tag) => !!tag),
	);

	const factions = [];
	for (const faction of _factions) {
		factions.push({ value: faction, description: faction });
	}
	return factions;
}

function removeFilters() {
	removeContainer("People Filter");
	findAllElements(".users-list > li.tt-hidden").forEach((x) => x.classList.remove("tt-hidden"));

	userDataQueue = [];
	userDataRunning = false;
}

export default class AbroadPeopleFilterFeature extends Feature {
	constructor() {
		super("People Filter", "travel");
	}

	precondition() {
		return isAbroad();
	}

	isEnabled() {
		return settings.pages.travel.peopleFilter;
	}

	initialise() {
		initialiseFilters();
	}

	async execute() {
		await addFilters();
	}

	cleanup() {
		removeFilters();
	}

	storageKeys() {
		return ["settings.pages.travel.peopleFilter"];
	}
}
