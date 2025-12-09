const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line

const { waitForGoogleMapLoader } = require('./misc-utils');

const { sleep, log } = Apify.utils;

/**
 * Types keyword into search box, retries if needed and wait for navigation
 * @param {Puppeteer.Page} page 
 * @param {string} searchString 
 */
module.exports.searchInputBoxFlow = async (page, searchString) => {
    // there is no searchString when startUrls are used
    if (searchString) {
        await page.waitForSelector('#searchboxinput', { timeout: 15000 });
        await page.type('#searchboxinput', searchString);
    }

    await sleep(5000);
    try {
        await page.click('#searchbox-searchbutton');
    } catch (e) {
        const error = /** @type {Error} */ (e);
        log.warning(`click#searchbox-searchbutton ${error.message}`);
        try {
            /** @type {Puppeteer.ElementHandle<HTMLElement> | null} */
            const retryClickSearchButton = await page.$('#searchbox-searchbutton');
            if (!retryClickSearchButton) {
                throw new Error('Retry click search button was not found on the page.');
            }
            await retryClickSearchButton.evaluate(b => b.click());
        } catch (eOnRetry) {
            const eOnRetryError = /** @type {Error} */ (eOnRetry);
            log.warning(`retryClickSearchButton ${eOnRetryError.message}`);
            await page.keyboard.press('Enter');
        }
    }
    await sleep(5000);
    await waitForGoogleMapLoader(page);
}

/** 
 * @param {Puppeteer.Page} page 
 */
 module.exports.getPlacesCountInUI = async (page) => {
    return page.evaluate(() => {
        // Try multiple selectors to count places in UI
        const articleCount = $('[role="article"]').length;
        if (articleCount > 0) return articleCount;
        
        // Fallback selectors
        const linkCount = $('a.hfpxzc').length;
        if (linkCount > 0) return linkCount;
        
        const feedItems = $('[role="feed"] > div').length;
        if (feedItems > 0) return feedItems;
        
        // Count any place links
        const placeLinks = $('a[href*="/maps/place/"]').length;
        return placeLinks;
    });
}