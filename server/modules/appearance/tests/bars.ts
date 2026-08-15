/**
 * Bars that more than one test has to agree on.
 *
 * Not a `.test.ts`, so the runner does not collect it — importing one test file
 * from another would register its cases twice.
 *
 * The reason this file exists at all is that the same number has to bind the
 * generated themes and the built-in one. The presets were held to a measured
 * sidebar separation and the floor was not, and the floor turned out to have
 * exactly the defect the presets had just been fixed for: the rail, the header
 * and the chat all resolving to the same colour. A constant defined twice is a
 * constant that drifts, and the drift shows up as the default look quietly
 * being exempt from the bar it enforces on the model.
 */

/**
 * How far apart two adjacent regions have to sit to read as different planes.
 *
 * Deliberately low as contrast ratios go — this is not a legibility floor, it
 * is a "these are two surfaces, not one" floor. Anything much higher starts
 * dictating that every theme have a dark rail, and the request was for a look
 * that is *slightly* separated rather than one that reads as two applications
 * stapled together. Below it the surfaces merge: three shipped presets and the
 * built-in look were all sitting at exactly 1.000.
 */
export const REGION_SEPARATION = 1.15;
