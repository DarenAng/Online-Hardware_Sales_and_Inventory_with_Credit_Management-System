// phone-picker.js -- the country button beside the phone box
// Loaded by: every page with a phone box (after format.js)
//
// The button prints the code (PH +63) and opens a searchable list; the box
// holds the national number, digits only. A number pasted with its + is read
// for its country. The list opens in its own layer at the foot of the page
// because the cards clip what hangs past their edge. No flags: Windows draws
// them as two letters in a box.

// ISO 3166 code, name, dialling code; alphabetical by name
const PHONE_COUNTRIES = [
    ['AF', 'Afghanistan', '93'], ['AL', 'Albania', '355'], ['DZ', 'Algeria', '213'],
    ['AS', 'American Samoa', '1'], ['AD', 'Andorra', '376'], ['AO', 'Angola', '244'],
    ['AI', 'Anguilla', '1'], ['AG', 'Antigua and Barbuda', '1'], ['AR', 'Argentina', '54'],
    ['AM', 'Armenia', '374'], ['AW', 'Aruba', '297'], ['AU', 'Australia', '61'],
    ['AT', 'Austria', '43'], ['AZ', 'Azerbaijan', '994'], ['BS', 'Bahamas', '1'],
    ['BH', 'Bahrain', '973'], ['BD', 'Bangladesh', '880'], ['BB', 'Barbados', '1'],
    ['BY', 'Belarus', '375'], ['BE', 'Belgium', '32'], ['BZ', 'Belize', '501'],
    ['BJ', 'Benin', '229'], ['BM', 'Bermuda', '1'], ['BT', 'Bhutan', '975'],
    ['BO', 'Bolivia', '591'], ['BA', 'Bosnia and Herzegovina', '387'], ['BW', 'Botswana', '267'],
    ['BR', 'Brazil', '55'], ['IO', 'British Indian Ocean Territory', '246'],
    ['VG', 'British Virgin Islands', '1'], ['BN', 'Brunei', '673'], ['BG', 'Bulgaria', '359'],
    ['BF', 'Burkina Faso', '226'], ['BI', 'Burundi', '257'], ['KH', 'Cambodia', '855'],
    ['CM', 'Cameroon', '237'], ['CA', 'Canada', '1'], ['CV', 'Cape Verde', '238'],
    ['KY', 'Cayman Islands', '1'], ['CF', 'Central African Republic', '236'], ['TD', 'Chad', '235'],
    ['CL', 'Chile', '56'], ['CN', 'China', '86'], ['CO', 'Colombia', '57'],
    ['KM', 'Comoros', '269'], ['CG', 'Congo', '242'], ['CD', 'Congo (DRC)', '243'],
    ['CK', 'Cook Islands', '682'], ['CR', 'Costa Rica', '506'], ['CI', "Côte d'Ivoire", '225'],
    ['HR', 'Croatia', '385'], ['CU', 'Cuba', '53'], ['CW', 'Curaçao', '599'],
    ['CY', 'Cyprus', '357'], ['CZ', 'Czechia', '420'], ['DK', 'Denmark', '45'],
    ['DJ', 'Djibouti', '253'], ['DM', 'Dominica', '1'], ['DO', 'Dominican Republic', '1'],
    ['EC', 'Ecuador', '593'], ['EG', 'Egypt', '20'], ['SV', 'El Salvador', '503'],
    ['GQ', 'Equatorial Guinea', '240'], ['ER', 'Eritrea', '291'], ['EE', 'Estonia', '372'],
    ['SZ', 'Eswatini', '268'], ['ET', 'Ethiopia', '251'], ['FK', 'Falkland Islands', '500'],
    ['FO', 'Faroe Islands', '298'], ['FJ', 'Fiji', '679'], ['FI', 'Finland', '358'],
    ['FR', 'France', '33'], ['GF', 'French Guiana', '594'], ['PF', 'French Polynesia', '689'],
    ['GA', 'Gabon', '241'], ['GM', 'Gambia', '220'], ['GE', 'Georgia', '995'],
    ['DE', 'Germany', '49'], ['GH', 'Ghana', '233'], ['GI', 'Gibraltar', '350'],
    ['GR', 'Greece', '30'], ['GL', 'Greenland', '299'], ['GD', 'Grenada', '1'],
    ['GP', 'Guadeloupe', '590'], ['GU', 'Guam', '1'], ['GT', 'Guatemala', '502'],
    ['GG', 'Guernsey', '44'], ['GN', 'Guinea', '224'], ['GW', 'Guinea-Bissau', '245'],
    ['GY', 'Guyana', '592'], ['HT', 'Haiti', '509'], ['HN', 'Honduras', '504'],
    ['HK', 'Hong Kong', '852'], ['HU', 'Hungary', '36'], ['IS', 'Iceland', '354'],
    ['IN', 'India', '91'], ['ID', 'Indonesia', '62'], ['IR', 'Iran', '98'],
    ['IQ', 'Iraq', '964'], ['IE', 'Ireland', '353'], ['IM', 'Isle of Man', '44'],
    ['IL', 'Israel', '972'], ['IT', 'Italy', '39'], ['JM', 'Jamaica', '1'],
    ['JP', 'Japan', '81'], ['JE', 'Jersey', '44'], ['JO', 'Jordan', '962'],
    ['KZ', 'Kazakhstan', '7'], ['KE', 'Kenya', '254'], ['KI', 'Kiribati', '686'],
    ['XK', 'Kosovo', '383'], ['KW', 'Kuwait', '965'], ['KG', 'Kyrgyzstan', '996'],
    ['LA', 'Laos', '856'], ['LV', 'Latvia', '371'], ['LB', 'Lebanon', '961'],
    ['LS', 'Lesotho', '266'], ['LR', 'Liberia', '231'], ['LY', 'Libya', '218'],
    ['LI', 'Liechtenstein', '423'], ['LT', 'Lithuania', '370'], ['LU', 'Luxembourg', '352'],
    ['MO', 'Macau', '853'], ['MG', 'Madagascar', '261'], ['MW', 'Malawi', '265'],
    ['MY', 'Malaysia', '60'], ['MV', 'Maldives', '960'], ['ML', 'Mali', '223'],
    ['MT', 'Malta', '356'], ['MH', 'Marshall Islands', '692'], ['MQ', 'Martinique', '596'],
    ['MR', 'Mauritania', '222'], ['MU', 'Mauritius', '230'], ['YT', 'Mayotte', '262'],
    ['MX', 'Mexico', '52'], ['FM', 'Micronesia', '691'], ['MD', 'Moldova', '373'],
    ['MC', 'Monaco', '377'], ['MN', 'Mongolia', '976'], ['ME', 'Montenegro', '382'],
    ['MS', 'Montserrat', '1'], ['MA', 'Morocco', '212'], ['MZ', 'Mozambique', '258'],
    ['MM', 'Myanmar', '95'], ['NA', 'Namibia', '264'], ['NR', 'Nauru', '674'],
    ['NP', 'Nepal', '977'], ['NL', 'Netherlands', '31'], ['NC', 'New Caledonia', '687'],
    ['NZ', 'New Zealand', '64'], ['NI', 'Nicaragua', '505'], ['NE', 'Niger', '227'],
    ['NG', 'Nigeria', '234'], ['NU', 'Niue', '683'], ['NF', 'Norfolk Island', '672'],
    ['KP', 'North Korea', '850'], ['MK', 'North Macedonia', '389'],
    ['MP', 'Northern Mariana Islands', '1'], ['NO', 'Norway', '47'], ['OM', 'Oman', '968'],
    ['PK', 'Pakistan', '92'], ['PW', 'Palau', '680'], ['PS', 'Palestine', '970'],
    ['PA', 'Panama', '507'], ['PG', 'Papua New Guinea', '675'], ['PY', 'Paraguay', '595'],
    ['PE', 'Peru', '51'], ['PH', 'Philippines', '63'], ['PL', 'Poland', '48'],
    ['PT', 'Portugal', '351'], ['PR', 'Puerto Rico', '1'], ['QA', 'Qatar', '974'],
    ['RE', 'Réunion', '262'], ['RO', 'Romania', '40'], ['RU', 'Russia', '7'],
    ['RW', 'Rwanda', '250'], ['BL', 'Saint Barthélemy', '590'], ['SH', 'Saint Helena', '290'],
    ['KN', 'Saint Kitts and Nevis', '1'], ['LC', 'Saint Lucia', '1'], ['MF', 'Saint Martin', '590'],
    ['PM', 'Saint Pierre and Miquelon', '508'], ['VC', 'Saint Vincent and the Grenadines', '1'],
    ['WS', 'Samoa', '685'], ['SM', 'San Marino', '378'], ['ST', 'São Tomé and Príncipe', '239'],
    ['SA', 'Saudi Arabia', '966'], ['SN', 'Senegal', '221'], ['RS', 'Serbia', '381'],
    ['SC', 'Seychelles', '248'], ['SL', 'Sierra Leone', '232'], ['SG', 'Singapore', '65'],
    ['SX', 'Sint Maarten', '1'], ['SK', 'Slovakia', '421'], ['SI', 'Slovenia', '386'],
    ['SB', 'Solomon Islands', '677'], ['SO', 'Somalia', '252'], ['ZA', 'South Africa', '27'],
    ['KR', 'South Korea', '82'], ['SS', 'South Sudan', '211'], ['ES', 'Spain', '34'],
    ['LK', 'Sri Lanka', '94'], ['SD', 'Sudan', '249'], ['SR', 'Suriname', '597'],
    ['SE', 'Sweden', '46'], ['CH', 'Switzerland', '41'], ['SY', 'Syria', '963'],
    ['TW', 'Taiwan', '886'], ['TJ', 'Tajikistan', '992'], ['TZ', 'Tanzania', '255'],
    ['TH', 'Thailand', '66'], ['TL', 'Timor-Leste', '670'], ['TG', 'Togo', '228'],
    ['TK', 'Tokelau', '690'], ['TO', 'Tonga', '676'], ['TT', 'Trinidad and Tobago', '1'],
    ['TN', 'Tunisia', '216'], ['TR', 'Türkiye', '90'], ['TM', 'Turkmenistan', '993'],
    ['TC', 'Turks and Caicos Islands', '1'], ['TV', 'Tuvalu', '688'], ['VI', 'U.S. Virgin Islands', '1'],
    ['UG', 'Uganda', '256'], ['UA', 'Ukraine', '380'], ['AE', 'United Arab Emirates', '971'],
    ['GB', 'United Kingdom', '44'], ['US', 'United States', '1'], ['UY', 'Uruguay', '598'],
    ['UZ', 'Uzbekistan', '998'], ['VU', 'Vanuatu', '678'], ['VA', 'Vatican City', '39'],
    ['VE', 'Venezuela', '58'], ['VN', 'Vietnam', '84'], ['WF', 'Wallis and Futuna', '681'],
    ['YE', 'Yemen', '967'], ['ZM', 'Zambia', '260'], ['ZW', 'Zimbabwe', '263'],
];

const PHONE_DEFAULT_COUNTRY = 'PH';

// The shop takes Philippine numbers only (phoneComplaint in format.js and
// server.js), so the button opens nothing. Set to null to make it a button.
const PHONE_ONLY_COUNTRY = 'PH';

// which country a shared code reads as when a stored number is put back
const PHONE_SHARED_CODE_HOME = { '1': 'US', '7': 'RU', '44': 'GB', '39': 'IT', '590': 'GP', '262': 'RE', '599': 'CW' };

// countries whose numbers keep the trunk 0 after the code
const PHONE_KEEPS_TRUNK_ZERO = ['IT', 'VA'];

function phoneCountry(iso) {
    const row = PHONE_COUNTRIES.find((c) => c[0] === iso);
    return row ? { iso: row[0], name: row[1], code: row[2] } : null;
}

// longest code that matches, and the home of a shared one
function phoneCountryForDigits(digits) {
    let best = null;
    if (PHONE_ONLY_COUNTRY) {
        const only = phoneCountry(PHONE_ONLY_COUNTRY);
        return only && digits.indexOf(only.code) === 0 ? only : null;
    }
    PHONE_COUNTRIES.forEach((row) => {
        const code = row[2];
        if (digits.indexOf(code) !== 0) return;
        if (best && best.code.length > code.length) return;
        if (best && best.code.length === code.length && PHONE_SHARED_CODE_HOME[code] !== row[0]) return;
        best = { iso: row[0], name: row[1], code };
    });
    return best;
}

// ---- the button beside the box ----

// Turns the printed prefix into the country button. Safe to call twice;
// format.js calls it again for boxes that only exist once a card has opened.
function setupPhoneField(input) {
    if (!input || input.dataset.phonePicker) return;
    const field = input.closest('.phone-field');
    if (!field) return;
    input.dataset.phonePicker = 'yes';

    const button = document.createElement(PHONE_ONLY_COUNTRY ? 'span' : 'button');
    button.className = 'phone-prefix phone-country' + (PHONE_ONLY_COUNTRY ? ' is-fixed' : '');
    if (PHONE_ONLY_COUNTRY) {
        button.setAttribute('aria-label', 'Country code');
    } else {
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'listbox');
        button.setAttribute('aria-label', 'Country');
        button.addEventListener('click', () => openPhoneMenu(input, button));
    }

    const printed = field.querySelector('.phone-prefix');
    if (printed) printed.replaceWith(button); else field.insertBefore(button, input);
    input._phoneButton = button;

    setPhoneCountry(input, input.dataset.country || PHONE_DEFAULT_COUNTRY);
}

function setPhoneCountry(input, iso) {
    const country = phoneCountry(iso) || phoneCountry(PHONE_DEFAULT_COUNTRY);
    input.dataset.country = country.iso;
    input.dataset.dialCode = country.code;
    input.placeholder = country.iso === 'PH' ? '9XX XXX XXXX' : 'Number';

    const button = input._phoneButton;
    if (button) {
        button.innerHTML =
            '<span class="phone-iso">' + country.iso + '</span>' +
            '<span class="phone-code">+' + country.code + '</span>' +
            (PHONE_ONLY_COUNTRY ? '' : '<span class="phone-caret" aria-hidden="true"></span>');
        button.title = PHONE_ONLY_COUNTRY
            ? 'Philippine numbers only: type the ten digits after +63, or the whole number starting 09'
            : country.name + ' +' + country.code;
    }
}

// ---- the list ----
let phoneMenu = null;          // the one open list, or null
let phoneMenuInput = null;     // the box it is choosing for

function openPhoneMenu(input, button) {
    closePhoneMenu();
    phoneMenuInput = input;

    const menu = document.createElement('div');
    menu.className = 'phone-menu';
    menu.innerHTML =
        '<input type="text" class="form-control phone-menu-search" ' +
        'placeholder="Search a country or code" aria-label="Search countries" autocomplete="off">' +
        '<ul class="phone-menu-list" role="listbox"></ul>';
    document.body.appendChild(menu);
    phoneMenu = menu;

    const rect = button.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    menu.style.width = width + 'px';
    menu.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
    const below = window.innerHeight - rect.bottom;
    if (below >= 330 || below >= rect.top) {
        menu.style.top = (rect.bottom + 4) + 'px';
        menu.style.maxHeight = (below - 16) + 'px';
    } else {
        menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        menu.style.maxHeight = (rect.top - 16) + 'px';
    }

    const search = menu.querySelector('.phone-menu-search');
    const list = menu.querySelector('.phone-menu-list');
    let active = -1;
    let shown = [];

    const render = () => {
        const query = search.value.trim().toLowerCase().replace(/^\+/, '');
        shown = PHONE_COUNTRIES.filter((row) =>
            query === '' ||
            row[1].toLowerCase().indexOf(query) !== -1 ||
            row[0].toLowerCase() === query ||
            (/^\d+$/.test(query) && row[2].indexOf(query) === 0));
        active = shown.length ? Math.max(0, shown.findIndex((row) => row[0] === input.dataset.country)) : -1;
        if (query !== '' && shown.length) active = 0;

        list.innerHTML = shown.length
            ? shown.map((row, i) =>
                '<li role="option" data-iso="' + row[0] + '"' +
                (row[0] === input.dataset.country ? ' class="selected"' : '') +
                ' aria-selected="' + (row[0] === input.dataset.country) + '">' +
                '<span class="phone-menu-name"><span class="phone-iso">' + row[0] + '</span>' +
                escapeHtml(row[1]) + '</span>' +
                '<span class="phone-menu-code">+' + row[2] + '</span></li>').join('')
            : '<li class="phone-menu-empty">No country matches that.</li>';
        highlight();
    };

    const highlight = () => {
        Array.from(list.children).forEach((li, i) => li.classList.toggle('active', i === active));
        const li = list.children[active];
        if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
    };

    const choose = (iso) => {
        setPhoneCountry(input, iso);
        closePhoneMenu();
        input.focus();
        if (typeof onPhoneInput === 'function') onPhoneInput(input);
    };

    list.addEventListener('mousedown', (event) => event.preventDefault());   // keep the search focused
    list.addEventListener('click', (event) => {
        const li = event.target.closest('li[data-iso]');
        if (li) choose(li.dataset.iso);
    });
    search.addEventListener('input', render);
    search.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); highlight(); event.preventDefault(); }
        else if (event.key === 'ArrowUp') { active = Math.max(0, active - 1); highlight(); event.preventDefault(); }
        else if (event.key === 'Enter') { if (shown[active]) choose(shown[active][0]); event.preventDefault(); }
        else if (event.key === 'Escape') { closePhoneMenu(); button.focus(); }
        else return;
        event.stopPropagation();   // Escape here closes the list, not the card around it
    });

    render();
    search.focus();

    setTimeout(() => {
        document.addEventListener('mousedown', onOutsidePhoneMenu);
        window.addEventListener('resize', closePhoneMenu);
        window.addEventListener('scroll', onPageScrollUnderPhoneMenu, true);
    }, 0);
}

// the page moving under the list closes it; the list scrolling itself does not
function onPageScrollUnderPhoneMenu(event) {
    if (phoneMenu && phoneMenu.contains(event.target)) return;
    closePhoneMenu();
}

function onOutsidePhoneMenu(event) {
    if (!phoneMenu) return;
    if (phoneMenu.contains(event.target)) return;
    if (phoneMenuInput && phoneMenuInput._phoneButton && phoneMenuInput._phoneButton.contains(event.target)) return;
    closePhoneMenu();
}

function closePhoneMenu() {
    if (!phoneMenu) return;
    phoneMenu.remove();
    phoneMenu = null;
    phoneMenuInput = null;
    document.removeEventListener('mousedown', onOutsidePhoneMenu);
    window.removeEventListener('resize', closePhoneMenu);
    window.removeEventListener('scroll', onPageScrollUnderPhoneMenu, true);
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.phone-field input').forEach(setupPhoneField);
});
