// Buyer-facing synonyms/Nigerian-English terms per sector, folded into
// storeEmbeddingText() (retrieval.service.js) alongside a vendor's own
// bio/sector labels — attacks the exact failure mode found live with
// "Ushering Services": a vendor tagged the right sector but their own store
// description never said "ushers"/"protocol" anywhere, so a buyer searching
// those words scored too far from the embedding to match. The sector label
// alone ("Ushering Services") isn't enough either — it's the formal name,
// not how a buyer actually phrases the request.
//
// Duplicated from velte-backend/src/utils/sectorLabels.js's
// SECTOR_KEYWORDS_BY_VALUE — that repo owns product/store write-time
// embedding (Store.sectors write path), this repo owns query-time
// reranking (see retrieval.service.js's rankCandidates, which recomputes
// embeddingTextFn fresh on every search rather than using the stored
// vector). Keyed by LABEL directly here (not slug) since this repo only
// ever has `store.sectors` (labels) on hand, never the slug. MUST be kept
// in sync by hand with velte-backend's copy — same duplication tradeoff as
// this repo's own voyage.service.js (see that file's header comment).
export const SECTOR_KEYWORDS_BY_LABEL = {
  "Restaurants & Quick Service": "restaurant, fast food, quick service, eatery, bukka, buka, canteen, food joint, food spot, diner, cafeteria, chops",
  "Catering & Event Food": "caterer, catering, event food, small chops, party food, cook for event, food vendor for party, jollof rice caterer, wedding caterer, party jollof, buffet",
  "Bakery & Pastries": "bakery, baker, cake, cakes, pastries, small chops, meat pie, birthday cake, wedding cake, cupcakes, pies, doughnut, confectioner",
  "Bars, Lounges & Nightlife": "bar, lounge, club, nightlife, pub, drinks spot, beer parlour, night club, hangout spot, chill spot, cocktail bar",
  "Street Food & Local Delicacies": "street food, local food, suya, roadside food, mama put, akara, boli, roasted corn, local delicacy, native food",
  "Confectionery & Snacks": "snacks, confectionery, chin chin, sweets, biscuits, small chops, puff puff, plantain chips, candy, treats",
  "Hotels & Short-lets": "hotel, shortlet, short let, guest house, lodge, apartment for rent, hotel room, event centre with rooms, guesthouse, inn, resort",
  "Event Planning Services": "event planner, event planning, wedding planner, party planner, decoration, event decor, event coordinator, event management, birthday planner, owanbe planner",
  "Ushering Services": "ushers, ushering, protocol, protocol officers, event protocol, guest management, red carpet ushers, ushering agency, wedding ushers, hostesses, event hostesses, guest reception",
  "Groceries & Supermarket": "grocery, supermarket, mini mart, food store, mart, shopping mall, grocery store, foodstuff seller",
  "Provision Stores & Kiosks": "provision store, kiosk, corner shop, mama put shop, mini shop, convenience store, roadside shop",
  "Wholesale & Distribution": "wholesale, distributor, bulk supply, distribution, bulk buyer, bulk seller, wholesaler, supplier",
  "Stationery & Books": "stationery, bookshop, books, office supplies, school supplies, exercise books, textbooks, bookstore",
  "Toys & Kids' Items": "toys, kids items, children's items, baby items, playthings, toy store, baby gear",
  "Gift Items & Souvenirs": "gifts, souvenirs, gift shop, hampers, gift items, gift baskets, party favours, wedding souvenirs",
  "Clothing & Apparel": "clothes, clothing, fashion, apparel, wears, outfits, boutique, ready to wear, senator wear, native wear, kaftan, agbada",
  "Shoes & Footwear": "shoes, footwear, sneakers, sandals, slippers, palm slippers, corporate shoes, native shoes",
  "Bags & Accessories": "bags, handbags, accessories, purses, wallets, backpacks, clutch bags, totes",
  "Jewelry & Watches": "jewelry, jewellery, watches, gold, accessories, beads, necklace, bangles, earrings, wristwatch",
  "Tailoring & Fashion Design": "tailor, tailoring, fashion designer, seamstress, aso ebi, sewing, ankara styles, native attire maker, dressmaker, cloth sewing, custom outfit",
  "Textile & Fabric Sales": "fabric, textile, ankara, lace, material seller, aso ebi fabric, george fabric, adire, brocade, senator material",
  "Phones & Accessories": "phone, phones, mobile phone, phone accessories, GSM, phone charger, phone case, earpiece, phone screen protector",
  "Computers & Laptops": "computer, laptop, computers, PC, desktop, notebook computer",
  "Home Electronics & Appliances": "electronics, home appliances, TV, fridge, electronics store, washing machine, home theatre, blender, microwave",
  "Gaming & Consoles": "gaming, console, PlayStation, Xbox, video games, PS5, gamepad, gaming accessories",
  "Software Development & IT Services": "software development, web developer, app developer, IT services, programmer, website, web app, mobile app, software engineer, coder, tech consultant, custom software, ecommerce website, database developer",
  "Phone & Gadget Repairs": "phone repair, gadget repair, screen repair, fix phone, phone technician, cracked screen fix, battery replacement",
  "Computer Repairs & IT Support": "computer repair, laptop repair, IT support, tech support, laptop technician, virus removal, data recovery",
  "Cosmetics & Skincare Retail": "cosmetics, skincare, beauty products, makeup products, skincare products, beauty store, cream seller",
  "Makeup Artistry": "makeup artist, MUA, bridal makeup, makeup, glam, face beat, makeover",
  "Spa & Massage": "spa, massage, masseuse, relaxation, wellness, body massage, spa treatment, therapy",
  "Nail Care": "nail tech, manicure, pedicure, nails, nail art, gel nails, acrylics",
  "Barbing & Hair Styling": "barber, barbing salon, hairstylist, hair salon, braiding, weaving, hairdresser, wig maker, haircut, dreadlocks, cornrows, salon",
  "Perfumes & Fragrances": "perfume, fragrance, cologne, scent, oil perfume, body spray, attar",
  Furniture: "furniture, chairs, tables, sofa, furniture maker, carpenter, wardrobe, bed frame, dining set",
  "Home Decor & Furnishings": "home decor, furnishings, interior decor, decoration items, wall art, curtains, rugs, decorative items",
  "Kitchenware & Appliances": "kitchenware, cookware, kitchen appliances, pots, pans, cutlery, kitchen utensils",
  "Bedding & Linens": "bedding, linens, bedsheets, duvet, pillows, mattress cover, bedspread",
  "Interior Design Services": "interior designer, interior design, home styling, space planning, home makeover",
  "Construction & Contracting": "construction, contractor, builder, building contractor, mason, building construction, renovation",
  "Architecture & Engineering Design": "architect, architecture, engineering design, building design, structural engineer, building plan, building drawing",
  "Plumbing Services": "plumber, plumbing, pipe repair, water leak, pipe fitting, toilet repair, water tank installation",
  "Electrical Installation Services": "electrician, electrical, wiring, rewiring, installation, electrical fault, generator wiring, socket repair",
  "Painting & Decorating Services": "painter, painting, decorator, wall painting, house painting, POP design",
  "Real Estate & Property Sales": "real estate, property, land for sale, house for sale, realtor, agent, apartment for sale, plot of land, property agent",
  "Property Management": "property manager, property management, facility management, landlord services, rent collection, estate management",
  "Auto Parts & Accessories": "auto parts, car parts, spare parts, car accessories, tokunbo parts, engine parts",
  "Vehicle Sales": "car sales, vehicle sales, cars for sale, dealership, buy a car, tokunbo cars, used cars",
  "Auto Repair & Mechanic Services": "mechanic, auto repair, car repair, panel beater, engine repair, car servicing",
  "Car Wash & Detailing": "car wash, auto detailing, car cleaning, car wash service",
  "Tyre Sales & Vulcanizing": "tyre, tire, vulcanizer, vulcanizing, tyre repair, tyre change, wheel balancing",
  "Motorcycle & Tricycle (Keke) Sales": "motorcycle, okada, keke, tricycle, bike sales, motorbike",
  "Generator Sales & Repair": "generator, gen repair, power plant, generator technician, gen set, soundproof generator",
  "Solar Panel Installation & Repair": "solar, solar panel, solar installation, inverter, solar system, battery inverter",
  "Appliance Repair": "appliance repair, fridge repair, AC repair, washing machine repair, air conditioner repair, freezer repair",
  "Shoe & Bag Repair (Cobbling)": "cobbler, shoe repair, bag repair, cobbling, shoe mender",
  "Watch Repair": "watch repair, watchmaker, clock repair, watch battery replacement",
  "Consulting & Advisory": "consultant, consulting, advisory, business advisor, strategy consultant",
  "Accounting & Bookkeeping": "accountant, accounting, bookkeeping, tax, audit, tax filing, financial statements",
  "Legal Services": "lawyer, legal services, attorney, solicitor, legal advice, contract drafting",
  "Marketing & Advertising": "marketing, advertising, ads, brand promotion, digital marketing, social media marketing, ad campaign",
  "Graphic Design & Branding": "graphic designer, branding, logo design, flyer design, brand identity, poster design",
  "Photography & Videography": "photographer, videographer, photography, video coverage, event coverage, wedding photographer, portrait photography",
  "Printing & Publishing": "printing, printer, publishing, print shop, flyer printing, banner printing, business cards",
  "Recruitment & HR Services": "recruitment, HR, headhunting, staffing agency, job placement, talent sourcing",
  "Translation & Interpretation": "translator, interpreter, translation services, language translation",
  "Virtual Assistance & Admin Support": "virtual assistant, VA, admin support, remote assistant, executive assistant",
  "Schools & Tutorial Centers": "school, tutorial center, lesson teacher, extra lessons, private lessons, home lessons, coaching class",
  "Vocational & Skills Training": "vocational training, skills acquisition, trade school, skill center",
  "Online Courses & E-learning": "online course, e-learning, online class, online training, virtual class",
  "Daycare & Creche": "daycare, creche, childminder, babysitter, nursery",
  "Logistics & Courier Services": "logistics, courier, delivery service, dispatch rider, package delivery, errand runner",
  "Ride-hailing & Car Hire": "ride hailing, car hire, taxi, chauffeur, private driver, drop service, car with driver",
  "Haulage & Trucking": "haulage, trucking, truck for hire, cargo transport, truck driver",
  "Moving & Relocation Services": "movers, moving service, relocation, house moving, office relocation",
  "Freight Forwarding & Clearing": "freight forwarding, customs clearing, clearing agent, shipping, import export agent",
  "Music & Audio Production": "music producer, audio production, studio, sound engineer, DJ, beat maker, recording studio",
  "Film & Video Production": "film production, video production, filmmaker, videographer, cinematographer",
  "Content Creation & Influencer Services": "content creator, influencer, social media content, UGC, brand ambassador",
  "Cleaning Services": "cleaner, cleaning service, house cleaning, office cleaning, post construction cleaning",
  "Laundry & Dry Cleaning": "laundry, dry cleaning, wash and iron, laundromat, ironing service",
  "Fumigation & Pest Control": "fumigation, pest control, exterminator, insect control, rodent control, termite control",
  "Domestic Staffing (Nanny, Cook, etc.)": "nanny, cook, house help, domestic staff, maid, steward, housekeeper, driver for hire",
  "Gardening & Landscaping": "gardener, landscaping, lawn care, garden maintenance, lawn mowing",
  "Security Services": "security guard, security services, bouncer, surveillance, CCTV installation, night guard",
};

/**
 * Flattens a store's sector LABELS into one deduped keyword string for
 * embedding text — e.g. ["Ushering Services"] → "ushers, ushering,
 * protocol, ...". Unknown labels (custom/legacy) are silently skipped
 * rather than breaking embedding generation.
 */
export function sectorKeywordsForLabels(sectorLabels) {
  const seen = new Set();
  for (const label of sectorLabels || []) {
    const kw = SECTOR_KEYWORDS_BY_LABEL[label];
    if (!kw) continue;
    for (const term of kw.split(",")) seen.add(term.trim());
  }
  return [...seen].join(", ");
}
