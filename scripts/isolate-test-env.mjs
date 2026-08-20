/**
 * Drain scripts export WAVE_LAND_MODE=apply. This suite's default closeout is
 * commit (ticket landMode still wins). Strip the inherited drain default so
 * `npm test` under jam verify does not switch unpinned fixtures to apply.
 */
delete process.env.WAVE_LAND_MODE;
