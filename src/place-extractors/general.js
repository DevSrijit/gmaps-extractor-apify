/* eslint-env jquery */
const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line

const { PlacePaginationData, PopularTimesOutput } = require('../typedefs');

const { PLACE_TITLE_SEL } = require('../consts');
const { waitForGoogleMapLoader, fixFloatNumber, navigateBack, unstringifyGoogleXrhResponse } = require('../utils/misc-utils');

const { log } = Apify.utils;

/**
 * TODO: There is much of this data in the JSON
 * @param {any} placeData
 * @param {boolean} isAdvertisement
*/
const parseJsonResult = (placeData, isAdvertisement) => {
    if (!placeData) {
        return;
    }

    const categories = placeData[13];

    // Some places don't have any address
    const addressDetail = placeData[183]?.[1];
    const addressParsed = {
        neighborhood: addressDetail?.[1],
        street: addressDetail?.[2],
        city: addressDetail?.[3],
        postalCode: addressDetail?.[4],
        state: addressDetail?.[5],
        countryCode: addressDetail?.[6],
    };

    const coordsArr = placeData[9];
    // TODO: Very rarely place[9] is empty, figure out why
    const coords = coordsArr
        ? { lat: fixFloatNumber(coordsArr[2]), lng: fixFloatNumber(coordsArr[3]) }
        : { lat: null, lng: null };

    return {
        placeId: placeData[78],
        coords,
        addressParsed,
        isAdvertisement,
        website: placeData[7]?.[0] || null,
        categories,
    };
}

/**
 * Response from google xhr is kind a weird. Mix of array of array.
 * This function parse places from the response body.
 * @param {string} responseBodyText
 * @param {boolean} isAllPacesNoSearch
 * @return {{ placesPaginationData: PlacePaginationData[], error: string | null }}
 */
module.exports.parseSearchPlacesResponseBody = (responseBodyText, isAllPacesNoSearch) => {
    /** @type {PlacePaginationData[]} */
    const placesPaginationData = [];

    /**
     * Google appends a trailing /*""*\/ marker to some responses and occasionally
     * returns the raw `)]}'` prefixed payload without wrapping it in JSON.
     * This helper removes the obvious wrappers so we can attempt parsing.
     */
    const cleanGoogleResponse = (text = '') => {
        let cleaned = text.trim();
        // strip trailing /*""*/ comment Google adds to map XHRs
        cleaned = cleaned.replace(/\/\*""\*\/\s*$/, '');
        // some responses start directly with the XSSI guard
        cleaned = cleaned.replace(/^\)\]\}\'[\s\n]*/, '');
        return cleaned;
    };

    let jsonString = cleanGoogleResponse(responseBodyText);

    // Check if response is empty or looks like HTML/error
    if (!jsonString || jsonString.length === 0) {
        log.warning(`[SEARCH DEBUG]: Response body is empty`);
        return {
            placesPaginationData,
            error: 'Response body is empty',
        };
    }

    if (jsonString.startsWith('<!DOCTYPE') || jsonString.startsWith('<html') || jsonString.startsWith('<HTML')) {
        log.warning(`[SEARCH DEBUG]: Response appears to be HTML instead of JSON. First 500 chars: ${jsonString.substring(0, 500)}`);
        return {
            placesPaginationData,
            error: 'Response body appears to be HTML instead of JSON',
        };
    }

    // Try to parse as-is first (might be wrapped in {"c":0,"d":"..."} format)
    let jsonObject;
    try {
        jsonObject = JSON.parse(jsonString);
    } catch (e) {
        // If that fails, try removing prefixes/comments again and retry
        jsonString = cleanGoogleResponse(jsonString);

        // Google sometimes wraps the XSSI protected payload directly without JSON
        // e.g. )]}'\n[...] so try to parse it as pure payload
        try {
            jsonObject = JSON.parse(jsonString);
        } catch (e2) {
            // Last resort: try to unstringify the body directly when it is the raw payload
            try {
                const data = unstringifyGoogleXrhResponse(jsonString);
                jsonObject = { d: jsonString, _directData: data };
            } catch (e3) {
                // Log detailed error information
                const error = /** @type {Error} */ (e2);
                log.warning(`[SEARCH DEBUG]: Failed to parse JSON. Error: ${error.message}`);
                log.warning(`[SEARCH DEBUG]: Response length: ${responseBodyText.length}, starts with: ${responseBodyText.substring(0, 200)}`);
                log.warning(`[SEARCH DEBUG]: Response ends with: ${responseBodyText.substring(Math.max(0, responseBodyText.length - 200))}`);
                // Check if response might be truncated
                if (jsonString.length > 0 && !jsonString.endsWith('}') && !jsonString.endsWith(']')) {
                    log.warning(`[SEARCH DEBUG]: Response might be truncated (doesn't end with } or ])`);
                }
                return {
                    placesPaginationData,
                    error: `Response body doesn't contain a valid JSON: ${error.message}`,
                };
            }
        }
    }

    // TODO: Maybe split this into more try/catches
    try {
        if (isAllPacesNoSearch) {
            const placeData = parseJsonResult(jsonObject[6], false);
            if (placeData) {
                placesPaginationData.push(placeData)
            } else {
                log.warning(`[SEARCH]: Cannot find place data while browsing with mouse over displayed places.`)
            }
            return { placesPaginationData, error: null };
        }

        // Debug: Check what's in jsonObject
        log.debug(`[SEARCH DEBUG]: jsonObject type: ${Array.isArray(jsonObject) ? 'array' : typeof jsonObject}, keys: ${Object.keys(jsonObject || {}).join(', ')}`);

        let data;
        if (jsonObject.d) {
            // Response is wrapped: {"c":0,"d":")]}'\n[..."}
            try {
                data = unstringifyGoogleXrhResponse(jsonObject.d);
                log.debug(`[SEARCH DEBUG]: Successfully unstringified jsonObject.d, data type: ${Array.isArray(data) ? 'array' : typeof data}`);
            } catch (e) {
                const error = /** @type {Error} */ (e);
                log.warning(`[SEARCH DEBUG]: Failed to unstringify jsonObject.d: ${error.message}`);
                log.warning(`[SEARCH DEBUG]: jsonObject.d type: ${typeof jsonObject.d}, length: ${typeof jsonObject.d === 'string' ? jsonObject.d.length : 'N/A'}`);
                log.warning(`[SEARCH DEBUG]: jsonObject.d preview: ${typeof jsonObject.d === 'string' ? jsonObject.d.substring(0, 500) : 'N/A'}`);

                // Try to manually parse by removing prefix and trimming
                try {
                    let cleaned = jsonObject.d;
                    if (typeof cleaned === 'string') {
                        cleaned = cleaned.replace(/^\)\]\}\'[\s\n]*/, '').trim();
                        if (cleaned.endsWith('/*""*/')) {
                            cleaned = cleaned.substring(0, cleaned.length - 6);
                        }
                        data = JSON.parse(cleaned);
                        log.debug(`[SEARCH DEBUG]: Successfully parsed jsonObject.d after manual cleaning`);
                    } else {
                        throw new Error('jsonObject.d is not a string');
                    }
                } catch (e2) {
                    const error2 = /** @type {Error} */ (e2);
                    log.warning(`[SEARCH DEBUG]: Manual parsing also failed: ${error2.message}`);
                    // Return error instead of using jsonObject directly (which won't have place data)
                    return {
                        placesPaginationData,
                        error: `Failed to parse wrapped response data: ${error.message}. Manual parse also failed: ${error2.message}`,
                    };
                }
            }
        } else {
            // Google might have changed the response format - the data might be directly in jsonObject
            log.debug(`[SEARCH DEBUG]: jsonObject.d is missing. Using jsonObject directly.`);
            data = jsonObject;
        }

        // We are paring ads but seems Google is not showing them to the scraper right now
        const ads = (data[2] && data[2][1] && data[2][1][0]) || [];

        ads.forEach((/** @type {any} */ ad) => {
            const placeData = parseJsonResult(ad[15], true);
            if (placeData) {
                placesPaginationData.push(placeData);
            } else {
                log.warning(`[SEARCH]: Cannot find place data for advertisement in search.`)
            }
        })

        /** @type {any} Too complex to type out*/
        // Google keeps shuffling the structure. We now recursively look for arrays
        // that look like place data (have coords at index 9 and enough fields).
        const isPlaceDataCandidate = (candidate) => Array.isArray(candidate)
            && Array.isArray(candidate[9])
            && candidate[9].length >= 2
            && candidate.length > 50;

        /** @type {any[]} */
        const foundPlaceArrays = [];
        const collectPlacesRecursively = (node, depth = 0, maxDepth = 6) => {
            if (depth > maxDepth || !Array.isArray(node)) return;

            if (isPlaceDataCandidate(node)) {
                foundPlaceArrays.push(node);
                return;
            }

            // Common pattern: [null, placeData, ...]
            if (node.length >= 2 && node[0] === null && isPlaceDataCandidate(node[1])) {
                foundPlaceArrays.push(node[1]);
            }

            for (const child of node) {
                collectPlacesRecursively(child, depth + 1, maxDepth);
            }
        };

        collectPlacesRecursively(data);

        if (foundPlaceArrays.length === 0) {
            // Some responses are very short metadata responses (e.g., )]}'\n[[[2],[3],[5],[6],[7],[9],[10]]])
            // These don't contain place data, so this is expected
            if (Array.isArray(data) && data.length < 5) {
                log.debug(`[SEARCH DEBUG]: Response appears to be a short metadata response (length: ${data.length}), no places expected`);
            } else {
                log.warning(`[SEARCH]: Could not find organic results in response. Data structure preview: ${JSON.stringify(data).substring(0, 1000)}`);
            }
            return { placesPaginationData, error: null };
        }

        const seenPlaceIds = new Set();
        let skippedMeta = 0;

        // Extract place data from results
        foundPlaceArrays.forEach((/** @type {any} */ result, index) => {
            const placeData = parseJsonResult(result, false);

            if (placeData?.placeId) {
                if (!seenPlaceIds.has(placeData.placeId)) {
                    seenPlaceIds.add(placeData.placeId);
                    placesPaginationData.push(placeData);
                } else {
                    log.debug(`[SEARCH DEBUG]: Skipping duplicate placeId ${placeData.placeId}`);
                }
            } else {
                skippedMeta++;
                // Keep noise down: these are usually metadata blocks (length ~200+) without coords/placeId
                log.debug(`[SEARCH]: Skipping non-place block at index ${index}. Type: ${Array.isArray(result) ? 'array' : typeof result}, length: ${Array.isArray(result) ? result.length : 'N/A'}`);
            }
        });

        if (skippedMeta > 0) {
            log.debug(`[SEARCH DEBUG]: Skipped ${skippedMeta} metadata/non-place blocks when parsing places`);
        }
    } catch (e) {
        const error = /** @type {Error} */ (e);
        return {
            placesPaginationData,
            error: `Failed parsing JSON response: ${error.message}`,
        };
    }
    return { placesPaginationData, error: null };
};







/**
 * We combine page and rich JSON data
 * @param {{
 *    page: Puppeteer.Page,
 *    jsonData: any,
 * }} options
 */
module.exports.extractPageData = async ({ page, jsonData }) => {
    const jsonResult = parseJsonResult(jsonData, false);
    return page.evaluate((placeTitleSel, jsonResult) => {
        const address = $('[data-section-id="ad"] .section-info-line').text().trim();
        const addressAlt = $("button[data-tooltip*='address']").text().trim();
        const addressAlt2 = $("button[data-item-id*='address']").text().trim();
        const secondaryAddressLine = $('[data-section-id="ad"] .section-info-secondary-text').text().replace('Located in:', '').trim();
        const secondaryAddressLineAlt = $("button[data-tooltip*='locatedin']").text().replace('Located in:', '').trim();
        const secondaryAddressLineAlt2 = $("button[data-item-id*='locatedin']").text().replace('Located in:', '').trim();
        const phone = $('[data-section-id="pn0"].section-info-speak-numeral').length
            // @ts-ignore
            ? $('[data-section-id="pn0"].section-info-speak-numeral').attr('data-href').replace('tel:', '')
            : $("button[data-tooltip*='phone']").text().trim();
        const phoneAlt = $('button[data-item-id*=phone]').text().trim();
        const categoryName = ((jsonResult.categories) && (jsonResult.categories.length > 0)) ? jsonResult.categories[0] : null;

        return {
            title: $(placeTitleSel).text().trim(),
            subTitle: $(`*:has(> ${placeTitleSel})+h2`).first().text().trim() || null,
            price: $("span[aria-label^='Price: ']").text().trim() || null,
            menu: $("button[aria-label='Menu']").text().replace(/Menu/g, '').trim() || null,
            // Getting from JSON now
            // totalScore: $('span.section-star-display').eq(0).text().trim(),
            categoryName: $('[jsaction="pane.rating.category"]').text().trim() || categoryName,
            address: address || addressAlt || addressAlt2 || null,
            locatedIn: secondaryAddressLine || secondaryAddressLineAlt || secondaryAddressLineAlt2 || null,
            ...jsonResult.addressParsed || {},
            plusCode: $('[data-section-id="ol"] .widget-pane-link').text().trim()
                || $("button[data-tooltip*='plus code']").text().trim()
                || $("button[data-item-id*='oloc']").text().trim() || null,
            website: jsonResult.website,
            phone: phone || phoneAlt || null,
            // Wasn't able to find this in the JSON
            temporarilyClosed: $('#pane,.skqShb').text().includes('Temporarily closed'),
            location: jsonResult.coords,
        };
    }, PLACE_TITLE_SEL, jsonResult || {});
};

/**
 * @param {{
 *    jsonData: any[]
 * }} options
 */
module.exports.extractPopularTimes = ({ jsonData }) => {
    if (!jsonData) {
        return {};
    }
    const popularTimesData = jsonData[84];
    if (!popularTimesData) {
        return {};
    }

    /** @type {PopularTimesOutput} */
    const output = {
        // Live data are not present if it is outside opening hours now
        popularTimesLiveText: popularTimesData[6] || null,
        popularTimesLivePercent: popularTimesData[7]?.[1] || null,
        popularTimesHistogram: {},
    };

    // Format of histogram we want for output is
    // { day: [{ hour, occupancyPercent}, ...], ...}

    // Format Google has is
    // [day][1][hour] => [0] for hour, [1] for occupancy

    const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    /** @type {any[]} */
    const daysData = popularTimesData[0];
    daysData.forEach((dayData, i) => {
        output.popularTimesHistogram[DAYS[i]] = [];
        const hoursData = dayData[1];
        if (Array.isArray(hoursData)) {
            for (const hourData of hoursData) {
                const hourOutput = { hour: hourData[0], occupancyPercent: hourData[1] };
                output.popularTimesHistogram[DAYS[i]].push(hourOutput)
            }
        }
    });
    return output;
};

/**
 * @param {{
 *    page: Puppeteer.Page,
 *    jsonData: any[]
 * }} options
 */
module.exports.extractOpeningHours = async ({ page, jsonData }) => {
    if (jsonData?.[34]?.[1]?.[0] && jsonData?.[34]?.[1]?.[1]) {
        return jsonData[34][1].map((/** @type {any[]} */ entry) => ({
            // adding a "," to make it consistent to extracting data from the DOM (old format)
            day: `${entry[0]},`,
            // replace "–" by " to " to make it consistent to extracting data from the DOM
            hours: entry[1].map((/** @type {string} */ hourInterval) => hourInterval.replace("–", " to ")).join(", ")
        }));
    }
    let result;
    const openingHoursSel = '.section-open-hours-container.section-open-hours-container-hoverable';
    const openingHoursSelAlt = '.section-open-hours-container.section-open-hours';
    const openingHoursSelAlt2 = '.section-open-hours-container';
    const openingHoursSelAlt3 = '[jsaction*=openhours]+[class*=open]';
    const openingHoursEl = (await page.$(openingHoursSel))
        || (await page.$(openingHoursSelAlt))
        || (await page.$(openingHoursSelAlt2))
        || (await page.$(openingHoursSelAlt3));
    if (openingHoursEl) {
        const openingHoursText = await page.evaluate((openingHoursElem) => {
            return openingHoursElem.getAttribute('aria-label');
        }, openingHoursEl);

        /** @type {string[]} */
        const openingHours = openingHoursText.split(openingHoursText.includes(';') ? ';' : ',');
        if (openingHours.length) {
            result = openingHours.map((line) => {
                const regexpResult = line.trim().match(/(\S+)\s(.*)/);
                if (regexpResult) {
                    // eslint-disable-next-line prefer-const
                    let [, day, hours] = regexpResult;
                    ([hours] = hours.split('.'));
                    return { day, hours };
                }
                log.debug(`[PLACE]: Not able to parse opening hours: ${line}`);
            });
        }
    }
    return result;
};

/**
 * @param {{
 *    page: Puppeteer.Page
 * }} options
 */
module.exports.extractPeopleAlsoSearch = async ({ page }) => {
    const result = [];
    const peopleSearchContainer = await page.$('.section-carousel-scroll-container');
    if (peopleSearchContainer) {
        const cardSel = 'button[class$="card"]';
        const cards = await peopleSearchContainer.$$(cardSel);
        for (let i = 0; i < cards.length; i++) {
            const searchResult = await page.evaluate((index, sel) => {
                const card = $(sel).eq(index);
                return {
                    title: card.find('div[class$="title"]').text().trim(),
                    totalScore: card.find('span[class$="rating"]').text().trim(),
                };
            }, i, cardSel);
            // For some reason, puppeteer click doesn't work here
            await Promise.all([
                page.evaluate((button, index) => {
                    $(button).eq(index).click();
                }, cardSel, i),
                page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle2'] }),
            ]);
            // @ts-ignore
            searchResult.url = await page.url();
            result.push(searchResult);
            await Promise.all([
                page.goBack({ waitUntil: ['domcontentloaded', 'networkidle2'] }),
                waitForGoogleMapLoader(page),
            ]);
        }
    }
    return result;
};

/**
 * @param {{
 *    page: Puppeteer.Page
 *    placeUrl: string,
 *    jsonData: any[]
 * }} options
 */
module.exports.extractAdditionalInfo = async ({ page, placeUrl, jsonData }) => {
    log.debug('[PLACE]: Scraping additional info.');
    let result;
    try {
        result = extractAdditionalInfoFromJson({ jsonData });
    } catch (/** @type any */ err) {
        log.warning(`[PLACE]: Couldn't extract additionalInfo from jsonData: ${err.message}; page: ${placeUrl}`);
    }
    if (result) {
        log.info(`[PLACE]: Additional info scraped from jsonData for page: ${placeUrl}`);
        return result;
    }
    await page.waitForSelector('button[jsaction*="pane.attributes.expand"]', { timeout: 5000 }).catch(() => { });
    const button = await page.$('button[jsaction*="pane.attributes.expand"]');
    if (button) {
        try {
            await button.click({ delay: 200 });
            await page.waitForSelector(PLACE_TITLE_SEL, { timeout: 30000, hidden: true });
            result = await page.evaluate(() => {
                /** @type {{[key: string]: any[]}} */
                const innerResult = {};
                $('div[role="region"]').each((_, section) => {
                    const key = $(section).find('*[class*="fontTitleSmall"]').text().trim();
                    /** @type {{[key: string]: boolean}[]} */
                    const values = [];
                    $(section).find('li:has(span[aria-label])').each((_i, sub) => {
                        /** @type {{[key: string]: boolean}} */
                        const res = {};
                        const title = $(sub).text().trim();
                        const isChecked = $(sub).find('img[src*=check_black]').length > 0;

                        // @ts-ignore
                        res[title] = isChecked;
                        values.push(res);
                    });
                    innerResult[key] = values;
                });
                return innerResult;
            });
            if (result && Object.keys(result).length > 0) {
                log.info(`[PLACE]: Additional info scraped from HTML for page: ${placeUrl}`);
            } else {
                log.info(`[PLACE]: Empty additional info section for page: ${placeUrl}`);
            }
        } catch (e) {
            log.info(`[PLACE]: ${e}Additional info not parsed`);
        } finally {
            await navigateBack(page, 'additional info', placeUrl);
        }
    } else {
        // DIV for "Hotel details" has the CSS class "WKLD0c"
        const hotel_avail_amenities = await page.$$eval('div[class="WKLD0c"] div:not([aria-disabled=true]) > span',
            (elements) => {
                return elements.map((element) => {
                    return element.textContent ? element.textContent.trim() : ''
                });
            }
        );
        const hotel_disabled_amenities = await page.$$eval('div[class="WKLD0c"] div[aria-disabled=true] > span',
            (elements) => {
                return elements.map((element) => {
                    return element.textContent ? element.textContent.trim() : ''
                });
            }
        );
        if (hotel_avail_amenities.length > 0) {
            const values = [];
            for (let name of hotel_avail_amenities) {
                values.push({ [name]: true })
            }
            for (let name of hotel_disabled_amenities) {
                values.push({ [name]: false })
            }
            log.info(`[PLACE]: Additional info (Amenities) scraped from HTML for page: ${placeUrl}`);
            return { "Amenities": values };
        } else {
            log.warning(`Didn't find additional data, skipping - ${page.url()}`);
        }
    }
    return result;
};

/**
 * Extracts additional infos for hotels and other categories according to the passed jsonData.
 *
 * Note: For hotels the jsonData often contains more infos than the Google-Maps page.
 * For some other places sometimes also additionInfos are in jsonData but not displayed on the page.
 * It never seems to be the other way around.
 *
 * @param {{
 *    jsonData: any[]
 * }} options
 * @return {Object | undefined} additional infos stored in jsonData, undefined if jsonData doesn't contain additional infos.
 * @throws {TypeError} if jsonData can't be parsed properly
 */
const extractAdditionalInfoFromJson = ({ jsonData }) => {
    // additional info for categories != hotel
    const resultBasic = extractAdditionalInfoBasicFromJson({ jsonData });
    // hotel amenities
    const resultHotel = extractHotelAmenitiesFromJson({ jsonData });
    if (resultBasic && resultHotel) {
        // @ts-ignore
        if (resultBasic?.Amenities) {
            // @ts-ignore
            resultBasic.Amenities = [...resultBasic.Amenities, ...resultHotel.Amenities]
            return resultBasic;
        }
        return { ...resultBasic, ...resultHotel }
    }
    return resultBasic ? resultBasic : resultHotel;
}

/**
 * Extracts additional infos which are visible for Google categories != hotel
 *
 * @param {{
 *    jsonData: any[]
 * }} options
 * @return {Object | undefined} additional infos stored in jsonData, undefined if jsonData doesn't contain basic additional infos.
 * @throws {TypeError} if jsonData can't be parsed properly
 */
const extractAdditionalInfoBasicFromJson = ({ jsonData }) => {
    if (!jsonData?.[100]) {
        return undefined;
    }
    if (!jsonData[100][1]?.[0]?.[1]
        || !Array.isArray(jsonData[100][1]?.[0]?.[2])) {
        throw new TypeError("wrong format");
    }
    const result = {}
    for (const section of jsonData[100][1]) {
        // @ts-ignore
        result[section[1]] = section[2].flatMap(option => {
            // @ts-ignore
            if (typeof option?.[1] !== 'string') {
                throw new TypeError("wrong format for option name");
            }
            if (typeof option?.[2]?.[2]?.[0] === 'number') {
                return { [option[1]]: option[2][2][0] == 1 }
            }
            // accepted types of credit cards are listed in JSON
            // (although the Google Maps Frontend doesn't show the specific types)
            if (option?.[0] === "/geo/type/establishment_poi/pay_credit_card_types_accepted") {
                const acceptedCards = option?.[2]?.[4]?.[1]?.[0]?.[0]
                if (Array.isArray(acceptedCards)) {
                    const firstCard = acceptedCards?.[0]
                    // each card is stored in an array with >= 4 elements
                    return { [option[1]]: Array.isArray(firstCard) && firstCard.length >= 4 }
                } else {
                    throw new TypeError(`${option[1]}: wrong format for accepted cards`);
                }
            }
            // wifi options are sometimes listed in JSON
            if (option?.[0] === "/geo/type/establishment_poi/wi_fi") {
                if (!Array.isArray(option?.[2]?.[3])) {
                    throw new TypeError(`wrong format for wifi options`);
                }
                const wifiOptions = option?.[2].slice(3)
                return wifiOptions.map((/** @type {any[]} */ wifiOption) => {
                    if (typeof wifiOption?.[2] != "string") {
                        throw new TypeError(`wrong format for wifi option`);
                    }
                    return { [wifiOption[2]]: true }
                });
            }
            throw new TypeError(`${option[1]}: wrong format for option value`);
        });
    };
    return result;
}

/**
 * Extracts the hotel details from the passed jsonData.
 * The return value will have the key "Amenities" to make it consistent to the old scraping from HTML.
 *
 * @param {{
 *    jsonData: any[]
 * }} options
 * @return {{Amenities:any[]} | undefined} hotel details (Amenities) stored in jsonData or undefined if jsonData doesn't contain hotel details.
 * @throws {TypeError} if jsonData can't be parsed properly
 */
const extractHotelAmenitiesFromJson = ({ jsonData }) => {
    // When Google doesn't display amenities, mostly jsonData[64] is null but
    // sometimes jsonData[64] also has a non-nested array with mostly nulls in it.
    // -> !jsonData?.[64] wouldn't be sufficient here
    if (!jsonData?.[64]?.[2]?.[0]) {
        return undefined;
    }
    if (!jsonData[64][2][0][2]
        || typeof jsonData[64][2][0][3] != 'number') {
        throw new TypeError("wrong format for hotel amenities");
    }
    return {
        "Amenities": jsonData[64][2].map((/** @type {any[]} */ option) => ({
            [option[2]]: option[3] == 1
        }))
    };
}
